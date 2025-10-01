// netlify/functions/inspections.js
// 擴充帳號模式 + 舊通關碼相容；GET 列表、POST 新增、DELETE 刪除（boss+admin）。
exports.handler = async (event) => {
  const ENV = process.env || {};
  const API_KEY   = ENV.JSONBIN_API_KEY;
  const BIN_ID    = ENV.JSONBIN_BIN_ID;
  const TPL_BIN_ID = ENV.JSONBIN_TPL_BIN_ID || ENV.JSONBIN_TEMPLATES_BIN_ID || '';
  const PASSCODE  = ENV.PASSCODE;

  // 解析 ACCOUNTS_JSON（舊機制）
  const BASE_ACCOUNTS = parseAccounts(ENV.ACCOUNT_JSON || ENV.ACCOUNTS_JSON || ENV.ACCOUNT_JSON);

  // 依環境變數擴充 input/viewer（新機制）
  const ACCOUNTS = buildAccounts(BASE_ACCOUNTS, {
    INPUT_USERS_CSV:   ENV.INPUT_USERS_CSV || '',
    INPUT_FIXED_PWD:   ENV.INPUT_FIXED_PWD || '',
    VIEWER_USERS_CSV:  ENV.VIEWER_USERS_CSV || '',
    VIEWER_FIXED_PWD:  ENV.VIEWER_FIXED_PWD || '',
  });

  // CORS
  if (event.httpMethod === 'OPTIONS') return text(200, 'OK');

  const qs = event.queryStringParameters || {};

  // 健康檢查（不需登入）
  if (event.httpMethod === 'GET' && (qs.health === '1' || qs.health === 'true')) {
    return json(200, { ok: true, runtime: process.version, hasFetch: typeof fetch === 'function' });
  }

  if (!API_KEY || !BIN_ID) {
    return json(500, { error: 'Missing env: JSONBIN_API_KEY / JSONBIN_BIN_ID' });
  }

  // --- 驗證 ---
  const auth = authenticate(ACCOUNTS, PASSCODE, event.headers);
  if (!auth.ok) return json(auth.status || 401, { ok:false, error: auth.error || 'Unauthorized' });

  // 回傳身份（前端登入檢查用）
  if (event.httpMethod === 'GET' && (qs.auth === '1' || qs.auth === 'true')) {
    return json(200, { ok: true, mode: auth.mode, role: auth.role, user: auth.user || '' });
  }

  
  // 診斷資料（admin/viewer）
  // GET /api/inspections?diag=1
  // 回傳目前主 BIN 與模板 BIN 的筆數與估算 PUT 大小（JSON 字串長度）。
  if (event.httpMethod === 'GET' && (qs.diag === '1' || qs.diag === 'true')) {
    if (!allow(auth.role, ['admin', 'viewer'])) return json(403, { ok:false, error: 'Forbidden' });

    const __BIN_MAIN = BIN_ID;
    const __BIN_TPL  = (TPL_BIN_ID || BIN_ID);

    const [gMain, gTpl] = await Promise.all([
      jsonbinGet(__BIN_MAIN, API_KEY),
      jsonbinGet(__BIN_TPL,  API_KEY),
    ]);

    const toInfo = (resp) => {
      if (!resp || !resp.ok) return { ok:false, status: resp?.status||0, approxBytes:0, count:0, detail:resp?.text||'' };
      const arr = listFromJson(resp.json);
      const str = JSON.stringify(arr || []);
      return {
        ok:true,
        count: Array.isArray(arr)?arr.length:0,
        approxBytes: str.length,
        approxKB: Math.round(str.length/102.4)/10,
        approxMB: Math.round(str.length/10485.76)/100,
        sampleIds: (arr||[]).slice(-3).map(x=>x && x.id).filter(Boolean)
      };
    };

    return json(200, {
      ok:true,
      main: toInfo(gMain),
      templates: toInfo(gTpl),
      hint: 'JSONBin 免費層單次 PUT 以及 bin 大小有上限，若 approxMB 接近上限，請分 Bin 或裁減歷史。'
    });
  }

  // 修復（admin）
  if (event.httpMethod === 'GET' && (qs.repair === '1' || qs.repair === 'true')) {
    if (!allow(auth.role, ['admin'])) return json(403, { ok:false, error:'Forbidden' });
    const __BIN_TPL = (TPL_BIN_ID || BIN_ID);
    const g = await jsonbinGet(__BIN_TPL, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    let list = listFromJson(g.json);
    list = dedupById(list);
    const p = await jsonbinPut(BIN_ID, API_KEY, list);
    if (!p.ok) return json(p.status || 500, { ok:false, error:'JSONBIN PUT failed', detail:p.text });
    return json(200, { ok:true, repaired:list.length });
  }

  
  // ====== 模板（預設版型）API ======
  // GET /api/inspections?templates=1             → 取得模板清單（admin/viewer/input 皆可）
  if (event.httpMethod === 'GET' && (qs.templates === '1' || qs.templates === 'true')) {
    if (!allow(auth.role, ['admin', 'viewer', 'input'])) return json(403, { ok:false, error:'Forbidden' });
    const __BIN_TPL = (TPL_BIN_ID || BIN_ID);
    const g = await jsonbinGet(__BIN_TPL, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    const list = listFromJson(g.json);
    const templates = list.filter(x => x && x.type === 'template');
    return json(200, { ok:true, templates });
  }

  // POST /api/inspections?template=1             → 儲存一筆模板（admin/input）
  if (event.httpMethod === 'POST' && (qs.template === '1' || qs.template === 'true')) {
    if (!allow(auth.role, ['admin', 'input'])) return json(403, { ok:false, error:'Forbidden' });
    let body = {}; try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const t = sanitizeTemplate(body.template || body.record || {}, auth.user);
    if (!t.ok) return json(400, { ok:false, error: t.error || 'Invalid template' });
    const rec = t.data;
    const __BIN_TPL = (TPL_BIN_ID || BIN_ID);
    const result = await saveWithRetry(__BIN_TPL, API_KEY, rec, 5);
    if (!result.ok) return json(result.lastStatus || 500, { ok:false, error:'Failed to save template', lastStatus: result.lastStatus, lastText: result.lastText });
    return json(200, { ok:true, id: rec.id });
  }
// 讀清單（admin/viewer）
  if (event.httpMethod === 'GET') {
    if (!allow(auth.role, ['admin', 'viewer'])) return json(403, { ok:false, error:'Forbidden' });
    const __BIN_TPL = (TPL_BIN_ID || BIN_ID);
    const g = await jsonbinGet(__BIN_TPL, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    return json(200, listFromJson(g.json));
  }

  // 新增（admin/input）
  if (event.httpMethod === 'POST') {
    if (!allow(auth.role, ['admin', 'input'])) return json(403, { ok:false, error:'Forbidden' });
    let body = {}; try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    if (!body || !body.record) return json(400, { ok:false, error:'Missing record' });

    const rec = sanitizeRecord(body.record, auth.user);
    const result = await saveWithRetry(BIN_ID, API_KEY, rec, 5);
    if (!result.ok) return json(500, { ok:false, error: 'Failed to save after retries', lastStatus: result.lastStatus, lastText: result.lastText });
    return json(200, { ok:true, id: rec.id });
  }

  // 刪除（boss+admin）
  if (event.httpMethod === 'DELETE') {
    const id = (qs.id || '').trim();
    if (!id) return json(400, { ok:false, error:'Missing id' });

    const isBoss = (String(auth.user || '').toLowerCase() === 'boss') && allow(auth.role, ['admin']);
    if (!isBoss) return json(403, { ok:false, error:'Forbidden' });

    const result = await deleteWithRetry(BIN_ID, API_KEY, id, 5);
    if (!result.ok) return json(result.lastStatus || 500, { ok:false, error:'Failed to delete', lastStatus: result.lastStatus, lastText: result.lastText });
    return json(200, { ok:true, deleted: result.deleted ? 1 : 0, id });
  }

  return json(405, { ok:false, error:'Method Not Allowed' });

  // ---- 小工具 ----
  function headers() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-passcode, x-user, x-pass',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    };
  }
  function json(code, obj) { return { statusCode: code, headers: headers(), body: JSON.stringify(obj) }; }
  function text(code, s)    { return { statusCode: code, headers: headers(), body: s }; }
};

/* ======= 帳號擴充 ======= */
function buildAccounts(baseAccounts, env) {
  const base = Array.isArray(baseAccounts) ? baseAccounts : [];
  const admins = base.filter(a => (a.role || '').toLowerCase() === 'admin');
  const parseCsv = (s) => String(s || '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
  const inputUsers  = parseCsv(env.INPUT_USERS_CSV);
  const viewerUsers = parseCsv(env.VIEWER_USERS_CSV);
  const inputPwd    = String(env.INPUT_FIXED_PWD || '');
  const viewerPwd   = String(env.VIEWER_FIXED_PWD || '');
  if ((inputUsers.length && inputPwd) || (viewerUsers.length && viewerPwd)) {
    const out = [...admins];
    for (const u of inputUsers)  out.push({ user: u, pwd: inputPwd,  role: 'input'  });
    for (const u of viewerUsers) out.push({ user: u, pwd: viewerPwd, role: 'viewer' });
    const seen = new Set(); const uniq = [];
    for (const a of out){ const k = (a.role||'').toLowerCase()+'::'+String(a.user||''); if (!seen.has(k)){ seen.add(k); uniq.push(a); } }
    return uniq;
  }
  return base;
}

/* ======= 驗證與授權 ======= */
function parseAccounts(raw) {
  try {
    if (!raw) return [];
    let s = String(raw);
    if (/^base64:/i.test(s)) s = Buffer.from(s.slice(7), 'base64').toString('utf8');
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function authenticate(accounts, passcodeEnv, headers) {
  const h = headers || {};
  const user = (h['x-user'] || h['X-User'] || '').trim();
  const pass = (h['x-pass'] || h['X-Pass'] || '').trim();
  const team = (h['x-passcode'] || h['X-Passcode'] || '').trim();

  if (accounts && accounts.length) {
    const found = accounts.find(a => String(a.user) === user && String(a.pwd) === pass);
    if (!found) return { ok:false, status:401, error:'Unauthorized' };
    const role = (found.role || 'input').toLowerCase();
    return { ok:true, mode:'accounts', role, user };
  }
  if (!passcodeEnv || team !== passcodeEnv) {
    return { ok:false, status:401, error:'Unauthorized' };
  }
  return { ok:true, mode:'passcode', role:'admin', user:user || '' };
}
function allow(role, list) { return list.includes((role || '').toLowerCase()); }

/* ======= JSONBIN I/O ======= */
async function jsonbinGet(binId, apiKey) {
  try {
    const r = await fetch('https://api.jsonbin.io/v3/b/' + binId + '/latest', {
      headers: { 'X-Master-Key': apiKey },
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
    return { ok: r.ok, status: r.status, text, json };
  } catch (e) {
    return { ok: false, status: 0, text: String(e) };
  }
}
async function jsonbinPut(binId, apiKey, list) {
  try {
    const r = await fetch('https://api.jsonbin.io/v3/b/' + binId, {
      method:'PUT', headers:{ 'Content-Type':'application/json', 'X-Master-Key': apiKey },
      body: JSON.stringify({ record: list })
    });
    const text = await r.text();
    return { ok:r.ok, status:r.status, text };
  } catch (e) {
    return { ok:false, status:0, text:String(e) };
  }
}

/* ======= 資料處理 ======= */
function listFromJson(data){
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.record) return listFromJson(data.record);
  if (data.records) return listFromJson(data.records);
  if (data.id && data.timestamp) return [data];
  return [];
}
function dedupById(arr){
  const seen = new Set(); const out = [];
  for (const x of arr){
    const id = String(x && x.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push(x);
  }
  return out;
}
function sanitizeRecord(r, who){
  try{
    const now = new Date().toISOString();
    const id = r.id && String(r.id) || `INS-${now.replace(/\D/g,'').slice(0,14)}-${Math.floor(100+Math.random()*900)}`;
    return {
      id, timestamp: r.timestamp || now,
      inspector: r.inspector || who || '',
      supplier: r.supplier || '', supplierEn: r.supplierEn || '', supplierCode: r.supplierCode || '',
      partNo: r.partNo || '', drawingNo: r.drawingNo || '',
      revision: r.revision || '',
      process: r.process || r.processCode || '',
      orderNo: r.orderNo || '',
      lotNo: r.lotNo || '',
      material: r.material || '',
      spec: r.spec || '',
      category: r.category || '',
      notes: r.notes || '',
      appearance: Array.isArray(r.appearance) ? r.appearance : [],
      measurements: Array.isArray(r.measurements) ? r.measurements : [],
      overallResult: r.overallResult || ''
    };
  }catch{ return r; }
}

/* ======= 驗證模板資料 ======= */
function sanitizeTemplate(tpl, user){
  const now = new Date().toISOString();
  const id = 'TPL-' + Math.random().toString(36).slice(2,10).toUpperCase();
  const key = tpl.key || {};
  const part = tpl.part || {};
  const rows = Array.isArray(tpl.rows) ? tpl.rows : [];
  // 至少需要有 supplier 或 partNo 等任一關鍵鍵
  const hasKey = ['supplier','partNo','drawingNo','material','spec','category','process'].some(k => String(key[k]||'').trim()!=='');
  if (!hasKey) return { ok:false, error:'Missing key fields' };
  const cleanRows = rows.filter(r => r && (r.appearance || r.code || r.item || r.nominal || r.tolMinus || r.tolPlus)).map(r=>({
    appearance: !!r.appearance,
    code: (r.code||'').toString().trim(),
    item: (r.item||'').toString().trim(),
    nominal: (r.nominal||'').toString().trim(),
    tolMinus: (r.tolMinus||'').toString().trim(),
    tolPlus: (r.tolPlus||'').toString().trim(),
  }));
  const rec = {
    id, type:'template', createdAt: now, updatedAt: now,
    owner: user || '',
    key: {
      supplier: (key.supplier||'').toString().trim(),
      partNo: (key.partNo||'').toString().trim(),
      drawingNo: (key.drawingNo||'').toString().trim(),
      material: (key.material||'').toString().trim(),
      spec: (key.spec||'').toString().trim(),
      category: (key.category||'').toString().trim(),
      process: (key.process||'').toString().trim(),
    },
    part: {
      partNo: (part.partNo||'').toString().trim(),
      drawingNo: (part.drawingNo||'').toString().trim(),
      material: (part.material||'').toString().trim(),
      spec: (part.spec||'').toString().trim(),
      category: (part.category||'').toString().trim(),
      process: (part.process||'').toString().trim(),
    },
    rows: cleanRows
  };
  return { ok:true, data: rec };
}

/* ======= 儲存/刪除（重試） ======= */
async function saveWithRetry(binId, apiKey, record, maxTry){
  let tries=0, lastStatus=0, lastText='';
  while (tries < (maxTry||3)){
    tries++;
    const g = await jsonbinGet(binId, apiKey);
    if (!g.ok){ lastStatus=g.status; lastText=g.text; continue; }
    const list = listFromJson(g.json);
    list.push(record);
    const p = await jsonbinPut(binId, apiKey, list);
    if (p.ok) return { ok:true };
    lastStatus = p.status; lastText = p.text;
    await new Promise(r => setTimeout(r, 250*tries));
  }
  return { ok:false, lastStatus, lastText };
}
async function deleteWithRetry(binId, apiKey, id, maxTry){
  let tries=0, lastStatus=0, lastText='';
  while (tries < (maxTry||3)){
    tries++;
    const g = await jsonbinGet(binId, apiKey);
    if (!g.ok){ lastStatus=g.status; lastText=g.text; continue; }
    const list = listFromJson(g.json).filter(x => x && x.id !== id);
    const p = await jsonbinPut(binId, apiKey, list);
    if (p.ok) return { ok:true, deleted:true };
    lastStatus = p.status; lastText = p.text;
    await new Promise(r => setTimeout(r, 250*tries));
  }
  return { ok:false, lastStatus, lastText };
}
