// netlify/functions/config.js
exports.handler = async () => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ binId: process.env.JSONBIN_BIN_ID || '' }),
  };
};
