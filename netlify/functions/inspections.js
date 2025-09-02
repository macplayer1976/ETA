// netlify/functions/inspections.js
exports.handler = async (event) => {
  // CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: 'OK' };
  }
  // 健康檢查（不需通關碼）
  const qs = event.queryStringParameters || {};
  if (event.httpMethod === 'GET' && (qs.health === '1' || qs.health === 'true')) {
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, runtime: process.version, hasFetch: typeof fetch === 'function' }) };
  }
  return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, msg: 'function alive' }) };
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-passcode',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}
