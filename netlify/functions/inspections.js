// netlify/functions/inspections.js
export async function handler(event) {
  const { JSONBIN_API_KEY, JSONBIN_BIN_ID, PASSCODE } = process.env;

  // CORS 預檢請求
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: 'OK',
    };
  }

  // 驗證通關碼（從 header 帶 x-passcode）
  const clientPasscode = event.headers['x-passcode'];
  if (!clientPasscode || clientPasscode !== PASSCODE) {
    return {
      statusCode: 401,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  try {
    if (event.httpMethod === 'GET') {
      // 讀取最新 Bin 內容（陣列）
      const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
        headers: {
          'X-Master-Key': JSONBIN_API_KEY,
        },
      });
      if (!res.ok) throw new Error(`JSONBIN GET failed: ${res.status}`);
      const data = await res.json(); // { record: [...] }
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify(data.record || []),
      };
    }

    if (event.httpMethod === 'POST') {
      // 取得一筆新檢驗紀錄
      const input = JSON.parse(event.body || '{}');
      if (!input || !input.record) {
        return {
          statusCode: 400,
          headers: corsHeaders(),
          body: JSON.stringify({ error: 'Missing record' }),
        };
      }

      // 先讀取舊資料
      const getRes = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
        headers: {
          'X-Master-Key': JSONBIN_API_KEY,
        },
      });
      if (!getRes.ok) throw new Error(`JSONBIN GET failed: ${getRes.status}`);
      const oldData = await getRes.json(); // { record: [...] }
      const list = Array.isArray(oldData.record) ? oldData.record : [];

      // 附加新資料
      list.push(input.record);

      // 寫回 JSONBIN（PUT 需包成 { record: ... }）
      const putRes = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': JSONBIN_API_KEY,
        },
        body: JSON.stringify({ record: list }),
      });
      if (!putRes.ok) throw new Error(`JSONBIN PUT failed: ${putRes.status}`);

      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({ ok: true }),
      };
    }

    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message }),
    };
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-passcode',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}
