// netlify/functions/inspections.js
// 穩定版：讀–合併–寫 + 重試 + 去重複（CommonJS 寫法，最相容）

exports.handler = async (event, context) => {
  try {
    const { JSONBIN_API_KEY, JSONBIN_BIN_ID, PASSCODE } = process.env;
    if (!JSONBIN_API_KEY || !JSONBIN_BIN_ID || !PASSCODE) {
      return resp(500, { error: 'Missing env: JSONBIN_API_KEY / JSONBIN_BIN_ID / PASSCODE' });
    }

    // CORS 預檢
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: cors(), body: 'OK' };
    }

    // 通關碼驗證
    const clientPasscode = event.headers['x-passcode'];
    if (!clientPasscode || clientPasscode !== PASSCODE) {
      return resp(401, { error: 'Unauthorized: bad passcode' });
    }

    if (event.httpMethod === 'GET') {
      const list = await getList(JSONBIN_BIN_ID, JSONBIN_API_KEY);
      return resp(200, list);
    }

    if (event.httpMethod === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch {}
      if (!body || !body.record) return resp(400, { error: 'Missing record' });

      // ★ 關鍵：寫入前先合併最新資料，且自動重試
      const ok = await saveWithRetry(JSONBIN_BIN_ID, JSONBIN_API_KEY, body.record, 5);
      if (!ok) return resp(500, { error: 'Failed to save after retries' });
      return resp(200, { ok: true });
    }

    return resp(405, { error: 'Method Not Allowed' });

  } catch (err) {
    return resp(500, { error: 'Server exception', detail: String(err && err.stack || err) });
  }
};

/* ----------------- 工具函式 ----------------- */

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-passcode',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}
function resp(code, obj) {
  return { statusCode: code, headers: cors(), body: JSON.stringify(obj) };
}

async function getList(binId, apiKey) {
  const r = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
    headers: { 'X-Master-Key': apiKey },
  });
  const text = await r.text();
  if (!r.ok) {
    // 回傳空陣列讓流程不中斷（同時把文字放在 detail 裡）
    return [];
  }
  try {
    const data = JSON.parse(text);
    // JSONBIN v3 通常是 { record: [...] }
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.record)) return data.record;
    if (data && Array.isArray(data.records)) return data.records;
    if (data && typeof data === 'object') return [data];
    return [];
  } catch {
    return [];
  }
}

async function putList(binId, apiKey, list) {
  const r = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': apiKey,
    },
    body: JSON.stringify({ record: list }),
  });
  const text = await r.text();
  return r.ok;
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

async function saveWithRetry(binId, apiKey, newRecord, maxTry = 5) {
  for (let i = 0; i < maxTry; i++) {
    // 1) 抓最新
    const latest = await getList(binId, apiKey);

    // 2) 合併（若這筆已存在以 id 判斷，就不重複加）
    let merged = dedupById([...latest, newRecord]);

    // 3) 寫回
    const ok = await putList(binId, apiKey, merged);
    if (ok) return true;

    // 4) 等一下再重試（每次等久一點）
    await sleep(150 * (i + 1));
  }
  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
