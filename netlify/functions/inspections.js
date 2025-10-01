
// netlify/functions/inspections.js
// 擴充帳號模式 + 舊通關碼相容；GET 列表、POST 新增、DELETE 刪除（boss+admin）。
// 2025-10-01: 新增 purgeTemplates（admin）以清空 JSONBin 內的模板，避免用量爆表。
//             其餘路由維持相容：templates=1 仍可讀雲端模板、template=1 仍可寫雲端模板（但前端已改為預設寫本機）。
exports.handler = async (event) => {
  const ENV = process.env || {};
  const API_KEY   = ENV.JSONBIN_API_KEY;
  const BIN_ID    = ENV.JSONBIN_BIN_ID;
  const PASSCODE  = ENV.PASSCODE;

  const BASE_ACCOUNTS = parseAccounts(ENV.ACCOUNT_JSON || ENV.ACCOUNTS_JSON || ENV.ACCOUNT_JSON);

  const ACCOUNTS = buildAccounts(BASE_ACCOUNTS, {
    INPUT_USERS_CSV:   ENV.INPUT_USERS_CSV || '',
    INPUT_FIXED_PWD:   ENV.INPUT_FIXED_PWD || '',
    VIEWER_USERS_CSV:  ENV.VIEWER_USERS_CSV || '',
    VIEWER_FIXED_PWD:  ENV.VIEWER_FIXED_PWD || '',
  });

  if (event.httpMethod === 'OPTIONS') return text(200, 'OK');

  const qs = event.queryStringParameters || {};

  if (event.httpMethod === 'GET' && (qs.health === '1' || qs.health === 'true')) {
    return json(200, { ok: true, runtime: process.version, hasFetch: typeof fetch === 'function' });
  }

  if (!API_KEY || !BIN_ID) {
    return json(500, { error: 'Missing env: JSONBIN_API_KEY / JSONBIN_BIN_ID' });
  }

  const auth = authenticate(ACCOUNTS, PASSCODE, event.headers);
  if (!auth.ok) return json(auth.status || 401, { ok:false, error: auth.error || 'Unauthorized' });

  if (event.httpMethod === 'GET' && (qs.auth === '1' || qs.auth === 'true')) {
    return json(200, { ok: true, mode: auth.mode, role: auth.role, user: auth.user || '' });
  }

  if (event.httpMethod === 'GET' && (qs.diag === '1' || qs.diag === 'true')) {
    if (!allow(auth.role, ['admin', 'viewer'])) return json(403, { ok:false, error: 'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error: 'JSONBIN GET failed', detail: g.text });
    const list = listFromJson(g.json);
    const last = list.length ? list[list.length-1] : null;
    return json(200, { ok:true, count:list.length, last: last ? { id:last.id, timestamp:last.timestamp, inspector:last.inspector, hasMeasurements: Array.isArray(last.measurements) } : null });
  }

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

  if (event.httpMethod === 'GET' && (qs.templates === '1' || qs.templates === 'true')) {
    if (!allow(auth.role, ['admin', 'viewer', 'input'])) return json(403, { ok:false, error:'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    const list = listFromJson(g.json);
    const templates = list.filter(x => x && x.type === 'template');
    return json(200, { ok:true, templates });
  }

  if (event.httpMethod === 'GET' && (qs.purgeTemplates === '1' || qs.purgeTemplates === 'true')) {
    if (!allow(auth.role, ['admin'])) return json(403, { ok:false, error:'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    const list = listFromJson(g.json);
    const kept = list.filter(x => !(x && x.type === 'template'));
    const removed = list.length - kept.length;
    const p = await jsonbinPut(BIN_ID, API_KEY, kept);
    if (!p.ok) return json(p.status || 500, { ok:false, error:'JSONBIN PUT failed', detail:p.text });
    return json(200, { ok:true, removed, kept: kept.length });
  }

  if (event.httpMethod === 'POST' && (qs.template === '1' || qs.template === 'true')) {
    if (!allow(auth.role, ['admin', 'input'])) return json(403, { ok:false, error:'Forbidden' });
    let body = {}; try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const t = sanitizeTemplate(body.template || body.record || {}, auth.user);
    if (!t.ok) return json(400, { ok:false, error: t.error || 'Invalid template' });
    const rec = t.data;
    const result = await saveWithRetry(BIN_ID, API_KEY, rec, 5);
    if (!result.ok) return json(500, { ok:false, error:'Failed to save template', lastStatus: result.lastStatus, lastText: result.lastText });
    return json(200, { ok:true, id: rec.id });
  }

  if (event.httpMethod === 'GET') {
    if (!allow(auth.role, ['admin', 'viewer'])) return json(403, { ok:false, error:'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    return json(200, listFromJson(g.json));
  }

  if (event.httpMethod === 'POST') {
    if (!allow(auth.role, ['admin', 'input'])) return json(403, { ok:false, error:'Forbidden' });
    let body = {}; try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    if (!body || !body.record) return json(400, { ok:false, error:'Missing record' });

    const rec = sanitizeRecord(body.record, auth.user);
    const result = await saveWithRetry(BIN_ID, API_KEY, rec, 5);
    if (!result.ok) return json(500, { ok:false, error: 'Failed to save after retries', lastStatus: result.lastStatus, lastText: result.lastText });
    return json(200, { ok:true, id: rec.id });
  }

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
function sanitizeTemplate(tpl, user){
  const now = new Date().toISOString();
  const id = 'TPL-' + Math.random().toString(36).slice(2,10).toUpperCase();
  const key = tpl.key || {};
  const part = tpl.part || {};
  const rows = Array.isArray(tpl.rows) ? tpl.rows : [];
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
      material: (part.material||'').toString().trim(),
      spec: (part.spec||'').toString().trim(),
      category: (part.category||'').toString().trim(),
      process: (part.process||'').toString().trim(),
    },
    rows: cleanRows
  };
  return { ok:true, data: rec };
}
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
