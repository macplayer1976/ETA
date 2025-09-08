
/**
 * Netlify Function: /api/inspections
 * Features:
 * - GET ?health=1: return {ok:true, bin, count}
 * - GET (list): return {records:[...]}
 * - GET ?id=...: return a single record object
 * - POST (create): append a record into JSONBin "records" array
 *
 * Auth:
 * - Uses ACCOUNT_JSON (JSON) and/or INPUT/VIEWER CSV + FIXED_PWD.
 * - Allows POST for role "input" or "admin".
 * - Accepts either the per-user password (x-pass) or shared PASSCODE (x-passcode) for write.
 */
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY || "";
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID || process.env.JSONBIN_BIB_ID || "";
const ACCOUNT_JSON = (()=>{ try{ return JSON.parse(process.env.ACCOUNT_JSON || "[]"); }catch{ return []; } })();
const INPUT_USERS = (process.env.INPUT_USERS_CSV || "").split(",").map(s=>s.trim()).filter(Boolean);
const VIEWER_USERS = (process.env.VIEWER_USERS_CSV || "").split(",").map(s=>s.trim()).filter(Boolean);
const INPUT_FIXED_PWD = process.env.INPUT_FIXED_PWD || "";
const VIEWER_FIXED_PWD = process.env.VIEWER_FIXED_PWD || "";
const PASSCODE = process.env.PASSCODE || "";

function json(res, status=200, headers={}){
  return { statusCode: status, headers: { "content-type":"application/json; charset=utf-8", ...headers }, body: JSON.stringify(res) };
}
function text(res, status=200, headers={}){
  return { statusCode: status, headers: { "content-type":"text/plain; charset=utf-8", ...headers }, body: String(res) };
}
function nowISO(){ return new Date().toISOString(); }

function roleOf(user, pass){
  user = String(user||"").trim(); pass = String(pass||"").trim();
  // 1) ACCOUNT_JSON exact match
  const acc = ACCOUNT_JSON.find(a => a && a.user===user && a.pwd===pass);
  if (acc && acc.role) return { ok:true, role: acc.role, user };
  // 2) INPUT via CSV + FIXED
  if (user && INPUT_USERS.includes(user) && pass && (pass===INPUT_FIXED_PWD || pass===PASSCODE)){
    return { ok:true, role:"input", user };
  }
  // 3) VIEWER via CSV + FIXED
  if (user && VIEWER_USERS.includes(user) && pass && (pass===VIEWER_FIXED_PWD || pass===PASSCODE)){
    return { ok:true, role:"viewer", user };
  }
  // 4) Fallback: if pass matches PASSCODE, treat as input (for field convenience)
  if (pass && PASSCODE && pass===PASSCODE) return { ok:true, role:"input", user:user||"unknown" };
  return { ok:false, role:"", user };
}

async function jsonbinLatest(){
  if (!JSONBIN_BIN_ID) throw new Error("Missing JSONBIN_BIN_ID/JSONBIN_BIB_ID");
  const url = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`;
  const r = await fetch(url, { headers: { "X-Master-Key": JSONBIN_API_KEY } });
  if (r.status === 404) return { record: { records: [] } };
  if (!r.ok){
    const t = await r.text();
    throw new Error(`JSONBin read failed: ${r.status} ${t}`);
  }
  return await r.json();
}

async function jsonbinPut(record){
  if (!JSONBIN_BIN_ID) throw new Error("Missing JSONBIN_BIN_ID/JSONBIN_BIB_ID");
  const url = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "X-Master-Key": JSONBIN_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(record)
  });
  if (!r.ok){
    const t = await r.text();
    throw new Error(`JSONBin write failed: ${r.status} ${t}`);
  }
  return await r.json();
}

function decideOverall(rec){
  // appearance: if any NG => FAIL; if none filled => undecided
  let appearanceOK = null;
  if (Array.isArray(rec.appearance) && rec.appearance.length){
    appearanceOK = rec.appearance.every(a => String(a.result||"").toUpperCase().startsWith("OK"));
  }
  // measurements
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
  return ""; // insufficient info
}

exports.handler = async (event, context) => {
  try{
    const method = event.httpMethod || "GET";
    const qs = event.queryStringParameters || {};
    const headers = event.headers || {};
    const user = headers["x-user"] || headers["X-User"] || "";
    const pass = headers["x-pass"] || headers["X-Pass"] || "";
    const passcode = headers["x-passcode"] || headers["X-Passcode"] || "";
    const auth = roleOf(user, pass || passcode);

    // Preflight
    if (method === "OPTIONS"){
      return {
        statusCode: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, x-user, x-pass, x-passcode",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
        },
        body: ""
      };
    }

    // Health & auth check
    if (qs.health){
      // Also try a lightweight JSONBin read to ensure connectivity
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

    // Data ops
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
      if (!(auth.ok && (auth.role==="input" || auth.role==="admin"))){
        return json({ error: "Forbidden" }, 403);
      }
      // Accept either per-user pass or shared PASSCODE for write (flexible)
      const perUserOK = ACCOUNT_JSON.some(a => a.user===auth.user && a.pwd===pass);
      const sharedOK = PASSCODE && passcode===PASSCODE;
      const fixedOK = INPUT_FIXED_PWD && pass===INPUT_FIXED_PWD;
      if (!(perUserOK || sharedOK || fixedOK || auth.role==="admin")){
        // Still allow if x-pass equals PASSCODE (field convenience)
        if (!(pass && PASSCODE && pass===PASSCODE)){
          return json({ error: "Invalid write credential" }, 403);
        }
      }

      let rec = {};
      try{ rec = JSON.parse(event.body || "{}"); }catch{}
      if (!rec || typeof rec !== "object") rec = {};

      // Attach server-side fields
      rec.id = rec.id || ("QCI-" + Date.now() + "-" + Math.random().toString(36).slice(2,8).toUpperCase());
      rec.timestamp = rec.timestamp || nowISO();
      rec.inspector = rec.inspector || auth.user || "unknown";
      rec.overall = decideOverall(rec);

      // Append
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
