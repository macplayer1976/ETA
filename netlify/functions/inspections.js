// netlify/functions/inspections.js
// 穩定版：讀–合併–寫 + 重試 + 去重複 + 巢狀資料自動攤平
exports.handler = async (event) => {
  const ENV = process.env || {};
  const API_KEY  = ENV.JSONBIN_API_KEY;
  const BIN_ID   = ENV.JSONBIN_BIN_ID;
  const PASSCODE = ENV.PASSCODE;

  // CORS
  if (event.httpMethod === 'OPTIONS') return text(200, 'OK');

  const qs = event.queryStringParameters || {};

  // 健康檢查（不需通關碼）
  if (event.httpMethod === 'GET' && (qs.health === '1' || qs.health === 'true')) {
    return json(200, { ok: true, runtime: process.version, hasFetch: typeof fetch === 'function' });
  }

  if (!API_KEY || !BIN_ID || !PASSCODE) {
    return json(500, { error: 'Missing env: JSONBIN_API_KEY / JSONBIN_BIN_ID / PASSCODE' });
  }

  // 通關碼驗證
  const clientPasscode = event.headers['x-passcode'];
  if (!clientPasscode || clientPasscode !== PASSCODE) {
    return json(401, { error: 'Unauthorized: bad passcode' });
  }

  // 診斷：摘要
  if (event.httpMethod === 'GET' && (qs.diag === '1' || qs.diag === 'true')) {
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

  // 修復：把巢狀資料攤平成乾淨陣列並寫回（GET /api/inspections?repair=1）
  if (event.httpMethod === 'GET' && (qs.repair === '1' || qs.repair === 'true')) {
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { error: 'JSONBIN GET failed', detail: g.text });
    let list = listFromJson(g.json);
    list = dedupById(list);
    const p = await jsonbinPut(BIN_ID, API_KEY, list);
    if (!p.ok) return json(p.status || 500, { error: 'JSONBIN PUT failed', detail: p.text });
    return json(200, { ok: true, repaired: list.length });
  }

  // 讀取全部
  if (event.httpMethod === 'GET') {
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { error: 'JSONBIN GET failed', detail: g.text });
    return json(200, listFromJson(g.json));
  }

  // 新增一筆
  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
    if (!body || !body.record) return json(400, { error: 'Missing record' });

    const result = await saveWithRetry(BIN_ID, API_KEY, body.record, 5);
    if (!result.ok) return json(500, { error: 'Failed to save after retries', lastStatus: result.lastStatus, lastText: result.lastText });
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method Not Allowed' });

  // ---- 工具 ----
  function headers() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-passcode',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
  }
  function json(code, obj) { return { statusCode: code, headers: headers(), body: JSON.stringify(obj) }; }
  function text(code, s)    { return { statusCode: code, headers: headers(), body: s }; }
};

/* -------------- JSONBIN 基本 I/O -------------- */
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
      body: JSON.stringify({ record: list }),
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: String(e) };
  }
}

/* -------------- 攤平巢狀資料 -------------- */
function looksLikeRecord(o) {
  return o && typeof o === 'object'
    && typeof o.id === 'string'
    && typeof o.timestamp === 'string'
    && Array.isArray(o.measurements);
}

// 遞迴把任何 {record: ...} / [{record:...}] / 混雜 metadata 的結構攤平成「純陣列」
function listFromJson(x) {
  if (!x) return [];
  if (Array.isArray(x)) {
    // 把每個元素遞迴攤平後合併
    return x.flatMap(listFromJson).filter(Boolean);
  }
  if (looksLikeRecord(x)) return [x];

  // 常見結構：{ record: [...] } 或 { record: { record: [...] }, metadata: {...} }
  if (x && typeof x === 'object') {
    if (x.record !== undefined) return listFromJson(x.record);
    if (x.records !== undefined) return listFromJson(x.records);
  }
  return [];
}

/* -------------- 去重複 & 儲存重試 -------------- */
function dedupById(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const id = item && item.id ? String(item.id) : '';
    if (!id) continue;                // 沒 id 的直接丟掉，避免髒資料
    if (!seen.has(id)) { seen.add(id); out.push(item); }
  }
  return out;
}

async function saveWithRetry(binId, apiKey, newRecord, maxTry) {
  let lastStatus = 0, lastText = '';
  for (let i = 0; i < maxTry; i++) {
    const g = await jsonbinGet(binId, apiKey);
    if (!g.ok) { lastStatus = g.status; lastText = g.text; await sleep(120 * (i + 1)); continue; }

    const latest = listFromJson(g.json);   // ★ 用新的攤平法取得「乾淨陣列」
    const merged = dedupById([...latest, newRecord]);

    const p = await jsonbinPut(binId, apiKey, merged);
    if (p.ok) return { ok: true };

    lastStatus = p.status; lastText = p.text;
    await sleep(150 * (i + 1));
  }
  return { ok: false, lastStatus, lastText };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
