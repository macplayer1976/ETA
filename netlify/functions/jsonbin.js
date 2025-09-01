// netlify/functions/jsonbin.js
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
  }

  const binId = process.env.JSONBIN_BIN_ID;
  const masterKey = process.env.JSONBIN_SECRET_KEY;
  if (!binId || !masterKey) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing JSONBIN_BIN_ID or JSONBIN_SECRET_KEY' }),
    };
  }

  const url = `https://api.jsonbin.io/v3/b/${binId}`;
  const headers = { 'X-Master-Key': masterKey, 'Content-Type': 'application/json' };

  try {
    if (event.httpMethod === 'GET') {
      const r = await fetch(url, { headers });
      const text = await r.text();
      return {
        statusCode: r.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: r.ok ? JSON.stringify(JSON.parse(text).record || {}) : text,
      };
    }

    if (event.httpMethod === 'PUT') {
      const r = await fetch(url, { method: 'PUT', headers, body: event.body || '{}' });
      const text = await r.text();
      return {
        statusCode: r.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: text,
      };
    }

    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
