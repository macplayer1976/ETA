
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY || "";
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID || process.env.JSONBIN_BIB_ID || "";
let ACCOUNT_JSON = [];
try{ ACCOUNT_JSON = JSON.parse(process.env.ACCOUNT_JSON || "[]"); }catch{ ACCOUNT_JSON = []; }
const INPUT_USERS = (process.env.INPUT_USERS_CSV || "").split(",").map(s=>s.trim()).filter(Boolean);
const VIEWER_USERS = (process.env.VIEWER_USERS_CSV || "").split(",").map(s=>s.trim()).filter(Boolean);
const INPUT_FIXED_PWD = process.env.INPUT_FIXED_PWD || "";
const VIEWER_FIXED_PWD = process.env.VIEWER_FIXED_PWD || "";
const PASSCODE = process.env.PASSCODE || "";

function corsHeaders(extra={}){
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-user, x-pass, x-passcode",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    ...extra
  };
}
function json(res, status=200, headers={}){
  return { statusCode: status, headers: corsHeaders({ "content-type":"application/json; charset=utf-8", ...headers }), body: JSON.stringify(res) };
}
function nowISO(){ return new Date().toISOString(); }

function readAuth(event){
  const qs = event.queryStringParameters || {};
  const headers = event.headers || {};
  let body = {};
  try{ body = JSON.parse(event.body || "{}"); }catch{ body = {}; }
  const embed = body.__auth || {};
  return {
    user: headers["x-user"] || headers["X-User"] || embed.user || qs.user || "",
    pass: headers["x-pass"] || headers["X-Pass"] || embed.pass || qs.pass || "",
    passcode: headers["x-passcode"] || headers["X-Passcode"] || embed.passcode || qs.passcode || ""
  };
}

function roleOf(user, pass){
  user = String(user||"").trim(); pass = String(pass||"").trim();
  const acc = ACCOUNT_JSON.find(a => a && a.user===user && a.pwd===pass);
  if (acc && acc.role) return { ok:true, role: acc.role, user };
  if (user && INPUT_USERS.includes(user) && pass && (pass===INPUT_FIXED_PWD || pass===PASSCODE)){
    return { ok:true, role:"input", user };
  }
  if (user && VIEWER_USERS.includes(user) && pass && (pass===VIEWER_FIXED_PWD || pass===PASSCODE)){
    return { ok:true, role:"viewer", user };
  }
  if (pass && PASSCODE && pass===PASSCODE) return { ok:true, role:"input", user:user||"unknown" };
  return { ok:false, role:"", user };
}

async function jsonbinLatest(){
  if (!JSONBIN_BIN_ID) throw new Error("Missing JSONBIN_BIN_ID/JSONBIN_BIB_ID");
  const url = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`;
  const r = await fetch(url, { headers: { "X-Master-Key": JSONBIN_API_KEY } });
  if (r.status === 404) return { record: { records: [] } };
  if (!r.ok){ const t = await r.text(); throw new Error(`JSONBin read failed: ${r.status} ${t}`); }
  return await r.json();
}
async function jsonbinPut(record){
  if (!JSONBIN_BIN_ID) throw new Error("Missing JSONBIN_BIN_ID/JSONBIN_BIB_ID");
  const url = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
  const r = await fetch(url, { method:"PUT", headers:{ "X-Master-Key": JSONBIN_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(record) });
  if (!r.ok){ const t = await r.text(); throw new Error(`JSONBin write failed: ${r.status} ${t}`); }
  return await r.json();
}

function decideOverall(rec){
  let appearanceOK = null;
  if (Array.isArray(rec.appearance) && rec.appearance.length){
    appearanceOK = rec.appearance.every(a => String(a.result||"").toUpperCase().startsWith("OK"));
  }
  let measureOK = null;
  if (Array.isArray(rec.measurements) && rec.measurements.length){
    measureOK = true;
    for (const m of rec.measurements){
      const nom = Number(m.nominal), lo = Number(m.tolMinus), hi = Number(m.tolPlus);
      const arr = Array.isArray(m.measured) ? m.measured : [];
      const hasNums = arr.some(v => v===0 || Number.isFinite(Number(v)));
      if ((Number.isFinite(nom) && Number.isFinite(lo) && Number.isFinite(hi) && hasNums)){
        const min = nom + lo, max = nom + hi;
        const ok = arr.filter(v => v===0 || Number.isFinite(Number(v))).map(Number).every(v => v>=min && v<=max);
        if (!ok){ measureOK = false; break; }
      }
    }
  }
  if (appearanceOK===false || measureOK===false) return "FAIL";
  if (appearanceOK===true && (measureOK===true || measureOK===null)) return "PASS";
  if (appearanceOK===null && measureOK===true) return "PASS";
  return "";
}

exports.handler = async (event) => {
  try{
    const method = event.httpMethod || "GET";
    const qs = event.queryStringParameters || {};

    if (method === "OPTIONS"){
      return { statusCode: 204, headers: corsHeaders(), body: "" };
    }

    const authIn = readAuth(event);
    const auth = roleOf(authIn.user, authIn.pass || authIn.passcode);

    if (qs.health){
      try{
        const data = await jsonbinLatest();
        const list = (data && data.record && Array.isArray(data.record.records)) ? data.record.records : [];
        return json({ ok:true, role: auth.ok?auth.role:"", bin: !!JSONBIN_BIN_ID, count: list.length });
      }catch(e){
        return json({ ok:false, error: String(e.message||e) }, 500);
      }
    }

    if (qs.auth){
      if (!auth.ok) return json({ ok:false }, 401);
      return json({ ok:true, user: auth.user, role: auth.role });
    }

    if (method === "GET"){
      const data = await jsonbinLatest();
      const list = (data && data.record && Array.isArray(data.record.records)) ? data.record.records : [];
      const id = qs.id;
      if (id){
        const one = list.find(r => r && r.id === id);
        if (!one) return json({ error: "Not found" }, 404);
        return json(one, 200);
      }
      return json({ records: list }, 200);
    }

    if (method === "POST"){
      const reasons = [];
      if (!auth.ok) reasons.push("auth invalid");
      if (!(auth.ok && (auth.role==="input" || auth.role==="admin"))) reasons.push("role not allowed");

      if (reasons.length){
        // Always detailed Forbidden (helps field debugging)
        return json({
          error: "Forbidden",
          reasons,
          received: {
            user: authIn.user || "",
            pass_present: !!authIn.pass,
            passcode_present: !!authIn.passcode
          },
          recognized_role: auth.role || ""
        }, 403);
      }

      let rec = {};
      try{ rec = JSON.parse(event.body || "{}"); }catch{}
      if (!rec || typeof rec !== "object") rec = {};
      rec.id = rec.id || ("QCI-" + Date.now() + "-" + Math.random().toString(36).slice(2,8).toUpperCase());
      rec.timestamp = rec.timestamp || nowISO();
      rec.inspector = rec.inspector || auth.user || "unknown";
      rec.overall = decideOverall(rec);

      const data = await jsonbinLatest();
      const root = data && data.record ? data.record : { records: [] };
      if (!Array.isArray(root.records)) root.records = [];
      root.records.push(rec);

      await jsonbinPut(root);
      return json({ ok:true, id: rec.id, timestamp: rec.timestamp, overall: rec.overall }, 200);
    }

    return json({ error: "Method not allowed" }, 405);
  }catch(e){
    return json({ error: String(e.message || e) }, 500);
  }
};
