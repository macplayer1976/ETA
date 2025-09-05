// netlify/functions/inspections.js
// 在不破壞原功能前提下，加入「input/viewer 可改帳號名、但密碼固定」的帳號擴充機制。
exports.handler = async (event) => {
  const ENV = process.env || {};
  const API_KEY   = ENV.JSONBIN_API_KEY;
  const BIN_ID    = ENV.JSONBIN_BIN_ID;
  const PASSCODE  = ENV.PASSCODE;

  // 解析 ACCOUNTS_JSON（舊機制）
  const BASE_ACCOUNTS = parseAccounts(ENV.ACCOUNTS_JSON);

  // 依環境變數擴充 input/viewer（新機制）；若沒設定，則回退到原本 BASE_ACCOUNTS
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

  // --- 驗證（帳號模式 或 舊通關碼模式） ---
  const auth = authenticate(ACCOUNTS, PASSCODE, event.headers);
  if (!auth.ok) return json(auth.status || 401, { error: auth.error || 'Unauthorized' });

  // 只回傳目前身分（前端登入檢查用）
  if (event.httpMethod === 'GET' && (qs.auth === '1' || qs.auth === 'true')) {
    return json(200, { ok: true, mode: auth.mode, role: auth.role, user: auth.user || '' });
  }

  // --- 路由與授權 ---
  // 診斷：admin / viewer
  if (event.httpMethod === 'GET' && (qs.diag === '1' || qs.diag === 'true')) {
    if (!allow(auth.role, ['admin', 'viewer'])) return json(403, { error: 'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { error: 'JSONBIN GET failed', detail: g.text });
    const list = listFromJson(g.json);
    const last = list.length ? list[list.length - 1] : null;
    return json(200, {
      ok: true,
      count: list.length,
      last: last ? {
        id: last.id, timestamp: last.timestamp, supplier: last.supplier,
        partNo: last.partNo, inspector: last.inspector,
        hasMeasurements: Array.isArray(last.measurements)
      } : null
    });
  }

  // 修復：僅 admin
  if (event.httpMethod === 'GET' && (qs.repair === '1' || qs.repair === 'true')) {
    if (!allow(auth.role, ['admin'])) return json(403, { error: 'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { error: 'JSONBIN GET failed', detail: g.text });
    let list = listFromJson(g.json);
    list = dedupById(list);
    const p = await jsonbinPut(BIN_ID, API_KEY, list);
    if (!p.ok) return json(p.status || 500, { error: 'JSONBIN PUT failed', detail: p.text });
    return json(200, { ok: true, repaired: list.length });
  }

  // 讀取清單：admin / viewer
  if (event.httpMethod === 'GET') {
    if (!allow(auth.role, ['admin', 'viewer'])) return json(403, { error: 'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { error: 'JSONBIN GET failed', detail: g.text });
    return json(200, listFromJson(g.json));
  }

  // 新增一筆：admin / input
  if (event.httpMethod === 'POST') {
    if (!allow(auth.role, ['admin', 'input'])) return json(403, { error: 'Forbidden' });
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
    if (!body || !body.record) return json(400, { error: 'Missing record' });

    const result = await saveWithRetry(BIN_ID, API_KEY, body.record, 5);
    if (!result.ok) return json(500, { error: 'Failed to save after retries', lastStatus: result.lastStatus, lastText: result.lastText });
    return json(200, { ok: true });
  }

  // 刪除一筆：僅 boss（且是 admin）
  if (event.httpMethod === 'DELETE') {
    const id = (qs.id || '').trim();
    if (!id) return json(400, { error: 'Missing id' });

    const isBoss = (String(auth.user || '').toLowerCase() === 'boss') && allow(auth.role, ['admin']);
    if (!isBoss) return json(403, { error: 'Forbidden' });

    const result = await deleteWithRetry(BIN_ID, API_KEY, id, 5);
    if (!result.ok) {
      const status = result.lastStatus || 500;
      return json(status, { error: 'Failed to delete', lastStatus: result.lastStatus, lastText: result.lastText });
    }
    return json(200, { ok: true, deleted: result.deleted ? 1 : 0, id });
  }

  return json(405, { error: 'Method Not Allowed' });

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

/* ======= 帳號擴充（保留 admin，input/viewer 走固定密碼 + 可改帳號名） ======= */
function buildAccounts(baseAccounts, env) {
  const base = Array.isArray(baseAccounts) ? baseAccounts : [];
  const admins = base.filter(a => (a.role || '').toLowerCase() === 'admin'); // admin 維持原樣

  // 解析 CSV → 陣列（允許中英文、空白會自動修剪）
  const parseCsv = (s) => String(s || '')
    .split(/[,，\n]/).map(x => x.trim()).filter(Boolean);

  const inputUsers  = parseCsv(env.INPUT_USERS_CSV);
  const viewerUsers = parseCsv(env.VIEWER_USERS_CSV);
  const inputPwd    = String(env.INPUT_FIXED_PWD || '');
  const viewerPwd   = String(env.VIEWER_FIXED_PWD || '');

  // 若有設定新的 CSV + 固定密碼 → 以新機制擴充（搭配 admin）
  if ((inputUsers.length && inputPwd) || (viewerUsers.length && viewerPwd)) {
    const out = [...admins];
    for (const u of inputUsers)  out.push({ user: u, pwd: inputPwd,  role: 'input'  });
    for (const u of viewerUsers) out.push({ user: u, pwd: viewerPwd, role: 'viewer' });
    // 去重（同帳號+角色只保留一筆；admin 不受影響）
    const key = (a) => `${(a.role||'').toLowerCase()}::${String(a.user||'')}`;
    const seen = new Set(); const uniq = [];
    for (const a of out) { const k = key(a); if (!seen.has(k)) { seen.add(k); uniq.push(a); } }
    return uniq;
  }

  // 沒設定新機制 → 完全沿用原本 ACCOUNTS_JSON
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

  // 有帳號清單 → 帳號模式
  if (accounts && accounts.length) {
    const found = accounts.find(a => String(a.user) === user && String(a.pwd) === pass);
    if (!found) return { ok: false, status: 401, error: 'Unauthorized' };
    const role = (found.role || 'input').toLowerCase();
    return { ok: true, mode: 'accounts', role, user };
  }
  // 否則退回舊通關碼模式（相容舊版）
  if (!passcodeEnv || team !== passcodeEnv) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true, mode: 'passcode', role: 'admin', user: user || '' }; // 舊模式視為 admin
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
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': apiKey },
      body: JSON.stringify({ record: list }),
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: String(e) };
  }
}

/* ======= 攤平 + 去重 ＆ 儲存/刪除 重試 ======= */
function looksLikeRecord(o) {
  return o && typeof o === 'object'
    && typeof o.id === 'string'
    && typeof o.timestamp === 'string'
    && Array.isArray(o.measurements);
}
function listFromJson(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.flatMap(listFromJson).filter(Boolean);
  if (looksLikeRecord(x)) return [x];
  if (x && typeof x === 'object') {
    if (x.record !== undefined) return listFromJson(x.record);
    if (x.records !== undefined) return listFromJson(x.records);
  }
  return [];
}
function dedupById(list) {
  const seen = new Set(); const out = [];
  for (const item of list) {
    const id = item && item.id ? String(item.id) : '';
    if (!id) continue;
    if (!seen.has(id)) { seen.add(id); out.push(item); }
  }
  return out;
}
async function saveWithRetry(binId, apiKey, newRecord, maxTry) {
  let lastStatus = 0, lastText = '';
  for (let i = 0; i < maxTry; i++) {
    const g = await jsonbinGet(binId, apiKey);
    if (!g.ok) { lastStatus = g.status; lastText = g.text; await sleep(120 * (i + 1)); continue; }
    const latest = listFromJson(g.json);
    const merged = dedupById([...latest, newRecord]);
    const p = await jsonbinPut(binId, apiKey, merged);
    if (p.ok) return { ok: true };
    lastStatus = p.status; lastText = p.text;
    await sleep(150 * (i + 1));
  }
  return { ok: false, lastStatus, lastText };
}
async function deleteWithRetry(binId, apiKey, id, maxTry) {
  let lastStatus = 0, lastText = '';
  for (let i = 0; i < maxTry; i++) {
    const g = await jsonbinGet(binId, apiKey);
    if (!g.ok) { lastStatus = g.status; lastText = g.text; await sleep(120 * (i + 1)); continue; }

    const latest = listFromJson(g.json);
    const exists = latest.some(it => it && String(it.id) === String(id));
    if (!exists) return { ok: true, deleted: 0 }; // 已不存在，視為成功

    const kept = latest.filter(it => it && String(it.id) !== String(id));
    const p = await jsonbinPut(binId, apiKey, kept);
    if (p.ok) return { ok: true, deleted: 1 };

    lastStatus = p.status; lastText = p.text;
    await sleep(150 * (i + 1));
  }
  return { ok: false, lastStatus, lastText };
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
