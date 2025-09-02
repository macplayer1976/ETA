// netlify/functions/inspections.js
// 加強版：讀–合併–寫 + 重試 + 去重複 + 詳細錯誤
// CommonJS 寫法（最相容）


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


const qs = event.queryStringParameters || {};


// ★ 健康檢查（不需通關碼）
if (event.httpMethod === 'GET' && (qs.health === '1' || qs.health === 'true')) {
return resp(200, { ok: true, runtime: process.version, hasFetch: typeof fetch === 'function' });
}


// 通關碼驗證（診斷模式除外？→ diag 仍需通關碼）
const clientPasscode = event.headers['x-passcode'];
if (!clientPasscode || clientPasscode !== PASSCODE) {
return resp(401, { error: 'Unauthorized: bad passcode' });
}


// ★ 診斷：只讀、回傳 bin 資訊（不動資料）
if (event.httpMethod === 'GET' && (qs.diag === '1' || qs.diag === 'true')) {
const g = await jsonbinGet(JSONBIN_BIN_ID, JSONBIN_API_KEY);
if (!g.ok) return resp(g.status || 500, { error: 'JSONBIN GET failed', detail: g.text });
const list = toList(g.json);
const peek = list.at(-1) || null;
return resp(200, {
ok: true,
count: list.length,
lastId: peek && peek.id,
lastTime: peek && peek.timestamp,
});
}


if (event.httpMethod === 'GET') {
const g = await jsonbinGet(JSONBIN_BIN_ID, JSONBIN_API_KEY);
if (!g.ok) return resp(g.status || 500, { error: 'JSONBIN GET failed', detail: g.text });
const list = toList(g.json);
return resp(200, list);
}


if (event.httpMethod === 'POST') {
let body = {};
try { body = JSON.parse(event.body || '{}'); } catch {}
if (!body || !body.record) return resp(400, { error: 'Missing record' });


function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }