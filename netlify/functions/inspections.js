// netlify/functions/inspections.js
// 多 JSONBIN 分流：量測資料使用 JSONBIN_BIN_ID；預設版型使用 1~3 個 JSONBIN_TEMPLATE_BIN_ID(_2/_3)
// 帳號與驗證機制維持不變。
// GET ?templates=1 會彙整三個模板 BIN 的清單；POST ?template=1 會自動選擇容量較小或第一個可用的模板 BIN 儲存。

exports.handler = async (event) => {
  const ENV = process.env || {};
  const API_KEY   = ENV.JSONBIN_API_KEY;
  const BIN_ID    = ENV.JSONBIN_BIN_ID; // 量測資料（既有 BIN）

  // 3 個模板 BIN（可只設 1 或 2 個，程式會自動忽略未設定者）
  const TPL_BINS = [
    ENV.JSONBIN_TEMPLATE_BIN_ID,
    ENV.JSONBIN_TEMPLATE_BIN_ID_2,
    ENV.JSONBIN_TEMPLATE_BIN_ID_3
  ].filter(Boolean);

  const PASSCODE  = ENV.PASSCODE;

  // 解析 ACCOUNTS_JSON（舊機制），並擴充 input/viewer（新機制）
  const BASE_ACCOUNTS = parseAccounts(ENV.ACCOUNT_JSON || ENV.ACCOUNTS_JSON || ENV.ACCOUNT_JSON);
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

  // 診斷資料（admin/viewer）—僅針對量測資料 BIN
  if (event.httpMethod === 'GET' && (qs.diag === '1' || qs.diag === 'true')) {
    if (!allow(auth.role, ['admin', 'viewer'])) return json(403, { ok:false, error: 'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error: 'JSONBIN GET failed', detail: g.text });
    const list = listFromJson(g.json);
    const last = list.length ? list[list.length-1] : null;
    return json(200, { ok:true, count:list.length, last: last ? { id:last.id, timestamp:last.timestamp, inspector:last.inspector, hasMeasurements: Array.isArray(last.measurements) } : null });
  }

  // 修復（admin）—僅針對量測資料 BIN
  if (event.httpMethod === 'GET' && (qs.repair === '1' || qs.repair === 'true')) {
    if (!allow(auth.role, ['admin'])) return json(403, { ok:false, error:'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    let list = listFromJson(g.json);
    list = dedupById(list);
    const p = await jsonbinPut(BIN_ID, API_KEY, list);
    if (!p.ok) return json(p.status || 500, { ok:false, error:'JSONBIN PUT failed', detail:p.text });
    return json(200, { ok:true, repaired:list.length });
  }

  // ====== 模板（預設版型）API（分流到模板 BIN） ======
  // GET /api/inspections?templates=1 → 取得模板清單（彙整 1~3 個模板 BIN）
  if (event.httpMethod === 'GET' && (qs.templates === '1' || qs.templates === 'true')) {
    if (!allow(auth.role, ['admin', 'viewer', 'input'])) return json(403, { ok:false, error:'Forbidden' });
    if (!TPL_BINS.length) {
      // 若未設定模板 BIN，向後相容：從量測 BIN 撈（舊資料）
      const g = await jsonbinGet(BIN_ID, API_KEY);
      if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
      const list = listFromJson(g.json);
      const templates = list.filter(x => x && x.type === 'template');
      return json(200, { ok:true, templates, bins:['DEFAULT_MEASURE_BIN'] });
    }
    // 併發抓取每個模板 BIN
    const results = await Promise.all(TPL_BINS.map(id => jsonbinGet(id, API_KEY)));
    let templates = [];
    const binsMeta = [];
    for (let i=0;i<results.length;i++){
      const r = results[i];
      const id = TPL_BINS[i];
      if (r.ok) {
        const list = listFromJson(r.json);
        templates = templates.concat(list.filter(x => x && x.type === 'template'));
        binsMeta.push({ bin:id, count: list.length });
      } else {
        binsMeta.push({ bin:id, error: r.text || `HTTP ${r.status||0}` });
      }
    }
    return json(200, { ok:true, templates, bins: binsMeta });
  }

  // POST /api/inspections?template=1 → 儲存一筆模板（自動挑選模板 BIN）
  if (event.httpMethod === 'POST' && (qs.template === '1' || qs.template === 'true')) {
    if (!allow(auth.role, ['admin', 'input'])) return json(403, { ok:false, error:'Forbidden' });
    let body = {}; try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const t = sanitizeTemplate(body.template || body.record || {}, auth.user);
    if (!t.ok) return json(400, { ok:false, error: t.error || 'Invalid template' });
    const rec = t.data;

    // 選擇目標 BIN：
    // - 若設定了 TPL_BINS：讀取每個 BIN 的清單，以項目數量少者為優先；若讀取失敗則略過；若全失敗則回退到第一個存在的 BIN（或量測 BIN）。
    // - 若未設定 TPL_BINS：回退到量測 BIN（向後相容）。
    let targetBin = BIN_ID;
    if (TPL_BINS.length) {
      const stats = await Promise.all(TPL_BINS.map(async (id) => {
        const r = await jsonbinGet(id, API_KEY);
        if (r.ok) return { id, ok:true, count: listFromJson(r.json).length };
        return { id, ok:false, error:r.text || `HTTP ${r.status||0}` };
      }));
      const okOnes = stats.filter(s => s.ok);
      if (okOnes.length) {
        okOnes.sort((a,b)=> (a.count||0) - (b.count||0));
        targetBin = okOnes[0].id;
      } else {
        // 全失敗時仍選擇第一個存在字串的 BIN，讓 PUT 嘗試（避免完全無路）
        targetBin = TPL_BINS[0];
      }
    }

    const result = await saveWithRetry(targetBin, API_KEY, rec, 5);
    if (!result.ok) return json(500, { ok:false, error:'Failed to save template', targetBin, lastStatus: result.lastStatus, lastText: result.lastText });
    return json(200, { ok:true, id: rec.id, bin: targetBin });
  }

  // ====== 量測資料 API（維持原行為，使用 BIN_ID） ======
  // 讀清單（admin/viewer）
  if (event.httpMethod === 'GET') {
    if (!allow(auth.role, ['admin', 'viewer'])) return json(403, { ok:false, error:'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
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

/* ======= JSONBIN 工具 ======= */
function listFromJson(json){ 
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.records)) return json.records;
  if (json && json.record && Array.isArray(json.record.records)) return json.record.records;
  return []; 
}
function dedupById(list){
  const seen = new Set(); const out = [];
  for (const r of list || []){
    const id = r && r.id ? String(r.id) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push(r);
  }
  return out;
}
async function jsonbinGet(binId, apiKey){
  try{
    const r = await fetch(`https://api.jsonbin.io/v3/b/${encodeURIComponent(binId)}/latest`, {
      method:'GET',
      headers: { 'X-Master-Key': apiKey, 'Content-Type':'application/json' }
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text).record ?? JSON.parse(text); } catch {}
    return { ok: r.ok, status:r.status, text, json };
  }catch(err){
    return { ok:false, status:0, text:String(err||'Error') };
  }
}
async function jsonbinPut(binId, apiKey, list){
  try{
    const body = JSON.stringify(Array.isArray(list) ? list : []);
    const r = await fetch(`https://api.jsonbin.io/v3/b/${encodeURIComponent(binId)}`, {
      method:'PUT',
      headers: { 'X-Master-Key': apiKey, 'Content-Type':'application/json' },
      body
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status:r.status, text, json };
  }catch(err){
    return { ok:false, status:0, text:String(err||'Error') };
  }
}
async function saveWithRetry(binId, apiKey, rec, times){
  const max = Math.max(1, times|0);
  let last = { ok:false, lastStatus:0, lastText:'' };
  for (let i=0;i<max;i++){
    const g = await jsonbinGet(binId, apiKey);
    if (!g.ok) { last.lastStatus = g.status || 0; last.lastText = g.text || ''; continue; }
    let list = listFromJson(g.json);
    list = Array.isArray(list) ? list : [];
    list = appendOrReplace(list, rec);
    const p = await jsonbinPut(binId, apiKey, list);
    if (p.ok) return { ok:true };
    last.lastStatus = p.status || 0; last.lastText = p.text || '';
  }
  return last;
}
function appendOrReplace(list, rec){
  const id = String(rec.id || '');
  if (!id) return list;
  let replaced = false;
  const out = list.map(x => {
    if (x && String(x.id||'') === id){ replaced = true; return rec; }
    return x;
  });
  return replaced ? out : [...out, rec];
}

/* ======= 資料清理 ======= */
function sanitizeRecord(raw, user){
  const now = new Date().toISOString();
  const id = raw.id && String(raw.id).trim() ? String(raw.id).trim() : `rec_${Date.now()}`;
  return {
    id,
    type:'record',
    timestamp: raw.timestamp || now,
    inspector: raw.inspector || user || '',
    supplier: raw.supplier || '',
    orderNo: raw.orderNo || '',
    lotNo: raw.lotNo || '',
    partNo: raw.partNo || '',
    drawingNo: raw.drawingNo || '',
    material: raw.material || '',
    spec: raw.spec || '',
    category: raw.category || '',
    process: raw.process || '',
    notes: raw.notes || '',
    measurements: Array.isArray(raw.measurements) ? raw.measurements : [],
    overall: raw.overall || '',
  };
}
function sanitizeTemplate(raw, user){
  const now = new Date().toISOString();
  const id = raw.id && String(raw.id).trim() ? String(raw.id).trim() : `tpl_${Date.now()}`;
  // 五鍵：drawingNo / material / spec / category / process
  const key = {
    drawingNo: String(raw.drawingNo || '').trim(),
    material:  String(raw.material  || '').trim(),
    spec:      String(raw.spec      || '').trim(),
    category:  String(raw.category  || '').trim(),
    process:   String(raw.process   || '').trim(),
  };
  if (!(key.drawingNo && key.material && key.spec && key.category && key.process)) {
    return { ok:false, error:'Missing 5-key fields (drawingNo/material/spec/category/process)' };
  }
  return {
    ok:true,
    data: {
      id,
      type:'template',
      timestamp: raw.timestamp || now,
      creator: user || '',
      key,
      // 存整張表格（含外觀＋尺寸）
      table: Array.isArray(raw.table) ? raw.table : [],
      meta: raw.meta || {}
    }
  };
}
