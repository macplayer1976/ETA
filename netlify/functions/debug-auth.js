
exports.handler = async (event)=>{
  function corsHeaders(extra={}){
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-user, x-pass, x-passcode",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      ...extra
    };
  }
  const qs = event.queryStringParameters || {};
  const headers = event.headers || {};
  let body = {};
  try{ body = JSON.parse(event.body || "{}"); }catch{ body = {}; }
  return {
    statusCode: 200,
    headers: corsHeaders({ "content-type":"application/json; charset=utf-8" }),
    body: JSON.stringify({
      note: "This endpoint helps you verify how the server receives your credentials.",
      received: {
        header: {
          "x-user": headers["x-user"]||headers["X-User"]||"",
          "x-pass": !!(headers["x-pass"]||headers["X-Pass"]),
          "x-passcode": !!(headers["x-passcode"]||headers["X-Passcode"]),
        },
        query: {
          user: qs.user || "",
          pass_present: !!qs.pass,
          passcode_present: !!qs.passcode
        },
        body: {
          has_auth_block: !!(body && body.__auth),
          user: body && body.__auth ? (body.__auth.user||"") : "",
          pass_present: !!(body && body.__auth && body.__auth.pass),
          passcode_present: !!(body && body.__auth && body.__auth.passcode)
        }
      }
    })
  };
};
