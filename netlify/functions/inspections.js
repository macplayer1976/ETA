// netlify/functions/inspections.js
// 讀–合併–寫 + 重試 + 去重複；含健康檢查與詳細錯誤回傳（CommonJS）
exports.handler = async (event) => {
  const ENV = process.env || {};
  const API_KEY  = ENV.JSONBIN_API_KEY;
  const BIN_ID   = ENV.JSONBIN_BIN_ID;
  const PASSCODE = ENV.PASSCODE;

  // CORS
  if (event.httpMethod === 'OPTIONS') return text(200, 'OK');

  // 健康檢查（不需通關碼）
  const qs = event.queryStringParameters || {};
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

  // 讀取全部
  if (event.httpMethod === 'GET') {
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { error: 'JSONBIN GET failed', detail: g.text });
    return json(200, toList(g.json));
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

  // ------------- 工具 -------------
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

function toList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.record)) return data.record;
  if (data && Array.isArray(data.records)) return data.records;
  if (data && typeof data === 'object') return [data];
  return [];
}

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

function dedupById(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const id = item && item.id ? String(item.id) : '';
    if (!id) { out.push(item); continue; }
    if (!seen.has(id)) { seen.add(id); out.push(item); }
  }
  return out;
}

async function saveWithRetry(binId, apiKey, newRecord, maxTry) {
  let lastStatus = 0, lastText = '';
  for (let i = 0; i < maxTry; i++) {
    const g = await jsonbinGet(binId, apiKey);
    if (!g.ok) { lastStatus = g.status; lastText = g.text; await sleep(120 * (i + 1)); continue; }

    const latest = toList(g.json);
    const merged = dedupById([...latest, newRecord]);

    const p = await jsonbinPut(binId, apiKey, merged);
    if (p.ok) return { ok: true };

    lastStatus = p.status; lastText = p.text;
    await sleep(150 * (i + 1));
  }
  return { ok: false, lastStatus, lastText };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
