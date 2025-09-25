
// netlify/functions/inspections.js
// 擴充：加入「模板（預設版型）」API，並維持既有 GET/POST/DELETE 介面不變。
// 角色權限：
// - 健康檢查與驗證：任何人可呼叫健康；驗證需正確帳密或通關碼/固定密碼。
// - 讀清單：admin/viewer（維持原規則）；但讀模板：admin/viewer/input 皆可。
// - 新增紀錄：admin/input（維持原規則）；新增模板：admin/input。
// - 刪除：boss+admin（維持原規則）。

exports.handler = async (event) => {
  const ENV = process.env || {};
  const API_KEY   = ENV.JSONBIN_API_KEY;
  const BIN_ID    = ENV.JSONBIN_BIN_ID;
  const PASSCODE  = ENV.PASSCODE;

  // 舊機制（注意：環境變數名採用 ACCOUNTS_JSON 與使用者提供一致）
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

  // --- 驗證（帳號/固定密碼/通關碼皆支援） ---
  const auth = authenticate(ACCOUNTS, PASSCODE, event.headers);
  if (!auth.ok) return json(auth.status || 401, { ok:false, error: auth.error || 'Unauthorized' });

  // 回傳身份（前端登入檢查用）
  if (event.httpMethod === 'GET' && (qs.auth === '1' || qs.auth === 'true')) {
    return json(200, { ok: true, mode: auth.mode, role: auth.role, user: auth.user || '' });
  }

  // ====== 模板（預設版型）API ======
  // GET /api/inspections?templates=1             → 取得模板清單（admin/viewer/input 皆可）
  if (event.httpMethod === 'GET' && (qs.templates === '1' || qs.templates === 'true')) {
    if (!allow(auth.role, ['admin', 'viewer', 'input'])) return json(403, { ok:false, error:'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
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
    const result = await saveWithRetry(BIN_ID, API_KEY, rec, 5);
    if (!result.ok) return json(500, { ok:false, error:'Failed to save template', lastStatus: result.lastStatus, lastText: result.lastText });
    return json(200, { ok:true, id: rec.id });
  }

  // ====== 原本的診斷/修復/讀取/新增/刪除 ======
  // 診斷資料（admin/viewer）
  if (event.httpMethod === 'GET' && (qs.diag === '1' || qs.diag === 'true')) {
    if (!allow(auth.role, ['admin', 'viewer'])) return json(403, { ok:false, error: 'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error: 'JSONBIN GET failed', detail: g.text });
    const list = listFromJson(g.json);
    const last = list.filter(x => x.type !== 'template').pop() || null;
    return json(200, { ok:true, count:list.filter(x=>x.type!=='template').length, last: last ? { id:last.id, timestamp:last.timestamp, inspector:last.inspector, hasMeasurements: Array.isArray(last.measurements) } : null });
  }

  // 修復（admin）
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

  // 讀清單（admin/viewer）
  if (event.httpMethod === 'GET') {
    if (!allow(auth.role, ['admin', 'viewer'])) return json(403, { ok:false, error:'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    return json(200, listFromJson(g.json).filter(x => x.type !== 'template'));
  }

  // 新增紀錄（admin/input）
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
    const qs = event.queryStringParameters || {};
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
  const parseCsv = (s) => String(s || '').split(/[,，\\n]/).map(x => x.trim()).filter(Boolean);
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
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': apiKey,
      },
      body: JSON.stringify(list),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
    return { ok: r.ok, status: r.status, text, json };
  } catch (e) {
    return { ok:false, status:0, text:String(e) };
  }
}
async function jsonbinPatch(binId, apiKey, list) {
  try {
    const r = await fetch('https://api.jsonbin.io/v3/b/' + binId, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': apiKey,
      },
      body: JSON.stringify(list),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
    return { ok: r.ok, status: r.status, text, json };
  } catch (e) {
    return { ok:false, status:0, text:String(e) };
  }
}

/* ======= 資料操作 ======= */
function listFromJson(json){
  if (!json) return [];
  const doc = json.record || json.records || json || [];
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc.items)) return doc.items;
  return [];
}

function uuid(){
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function nowIso(){
  return new Date().toISOString();
}

function sanitizeRecord(rec, user){
  const r = rec && typeof rec === 'object' ? JSON.parse(JSON.stringify(rec)) : {};
  r.id = r.id || uuid();
  r.type = 'record';
  r.timestamp = r.timestamp || nowIso();
  if (user) r.inspector = r.inspector || user;
  r.basic = r.basic || {};
  r.part  = r.part  || {};
  r.measurements = Array.isArray(r.measurements) ? r.measurements : [];
  return r;
}

function sanitizeTemplate(tpl, user){
  if (!tpl || typeof tpl !== 'object') return { ok:false, error:'template missing' };
  const t = JSON.parse(JSON.stringify(tpl));
  t.id = t.id || uuid();
  t.type = 'template';
  t.timestamp = nowIso();
  if (user) t.creator = user;
  const norm = (s)=> String(s||'').trim().toUpperCase();
  t.key = {
    supplier: norm(t.key?.supplier || t.basic?.supplier || ''),
    partNo:   norm(t.key?.partNo   || t.part?.partNo   || ''),
    drawingNo:norm(t.key?.drawingNo|| t.part?.drawingNo|| ''),
    material: norm(t.key?.material || t.part?.material || ''),
    spec:     norm(t.key?.spec     || t.part?.spec     || ''),
    category: norm(t.key?.category || t.part?.category || ''),
    process:  norm(t.key?.process  || t.part?.process  || ''),
  };
  for (const k of Object.keys(t.key)) if (!t.key[k]) delete t.key[k];
  t.basic = t.basic || {};
  t.part  = t.part  || {};
  t.rows  = Array.isArray(t.rows) ? t.rows.map(slimRow) : [];
  return { ok:true, data: t };

  function slimRow(r){
    const o = {};
    o.code = (r.code||'').trim();
    o.item = (r.item||'').trim();
    o.nominal = String(r.nominal ?? '').trim();
    o.tolMinus = String(r.tolMinus ?? '').trim();
    o.tolPlus  = String(r.tolPlus  ?? '').trim();
    o.appearance = !!r.appearance;
    return o;
  }
}

function dedupById(list){
  const seen = new Set(); const out = [];
  for (const it of list){
    if (!it || !it.id) { out.push(it); continue; }
    if (seen.has(it.id)) continue;
    seen.add(it.id); out.push(it);
  }
  return out;
}

async function saveWithRetry(binId, apiKey, rec, tries){
  let last = { ok:false, status:0, text:'' };
  for (let i=0;i<(tries||3);i++){
    const g = await jsonbinGet(binId, apiKey);
    if (!g.ok) { last = g; await wait(200*i); continue; }
    let list = listFromJson(g.json);
    list.push(rec);
    list = dedupById(list);
    const p = await jsonbinPatch(binId, apiKey, list);
    if (p.ok) return { ok:true };
    last = p;
    await wait(200*(i+1));
  }
  return { ok:false, lastStatus:last.status, lastText:last.text };
}
async function deleteWithRetry(binId, apiKey, id, tries){
  let last = { ok:false, status:0, text:'' };
  for (let i=0;i<(tries||3);i++){
    const g = await jsonbinGet(binId, apiKey);
    if (!g.ok) { last = g; await wait(200*i); continue; }
    let list = listFromJson(g.json);
    const n = list.length;
    list = list.filter(x => String(x.id) !== String(id));
    if (list.length === n) return { ok:true, deleted:false };
    const p = await jsonbinPut(binId, apiKey, list);
    if (p.ok) return { ok:true, deleted:true };
    last = p;
    await wait(200*(i+1));
  }
  return { ok:false, lastStatus:last.status, lastText:last.text };
}
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }
