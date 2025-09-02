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


// ★ 健康檢查（不需通關碼）：
// 直接打 https://你的站名.netlify.app/api/inspections?health=1
const qs = event.queryStringParameters || {};
if (event.httpMethod === 'GET' && (qs.health === '1' || qs.health === 'true')) {
return resp(200, { ok: true, runtime: process.version, hasFetch: typeof fetch === 'function' });
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
// 回傳空陣列讓流程不中斷（同時可視需要加上日誌或告警）
return [];
}
}