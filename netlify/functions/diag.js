// netlify/functions/diag.js
// 簡易 JSONBin 資料量診斷端點：GET /api/diag
exports.handler = async (event) => {
  const ENV = process.env || {};
  const API_KEY   = ENV.JSONBIN_API_KEY;
  const BIN_ID    = ENV.JSONBIN_BIN_ID;
  const TPL_BIN_ID = ENV.JSONBIN_TPL_BIN_ID || ENV.JSONBIN_TEMPLATES_BIN_ID || '';

  // 簡單 CORS
  if (event.httpMethod === 'OPTIONS') return text(200, 'OK');

  // 驗證：沿用 inspections 的 header 規則（x-user/x-pass 或 x-passcode），但只允許 admin/viewer
  const auth = authenticate(parseAccounts(ENV.ACCOUNT_JSON || ENV.ACCOUNTS_JSON || ''), ENV.PASSCODE, event.headers);
  if (!auth.ok) return json(auth.status || 401, { ok:false, error: auth.error || 'Unauthorized' });
  if (!allow(auth.role, ['admin','viewer'])) return json(403, { ok:false, error:'Forbidden' });

  if (!API_KEY || !BIN_ID) return json(500, { ok:false, error:'Missing env: JSONBIN_API_KEY / JSONBIN_BIN_ID' });

  const mainId = BIN_ID;
  const tplId  = TPL_BIN_ID || BIN_ID;

  const [gMain, gTpl] = await Promise.all([jsonbinGet(mainId, API_KEY), jsonbinGet(tplId, API_KEY)]);

  const toInfo = (resp) => {
    if (!resp || !resp.ok) return { ok:false, status: resp?.status||0, approxBytes:0, count:0, detail:resp?.text||'' };
    const arr = Array.isArray(resp.json) ? resp.json : (resp.json?.record || []);
    const str = JSON.stringify(arr || []);
    return {
      ok:true,
      count: Array.isArray(arr)?arr.length:0,
      approxBytes: str.length,
      approxKB: Math.round(str.length/102.4)/10,
      approxMB: Math.round(str.length/10485.76)/100,
      sampleIds: (arr||[]).slice(-3).map(x=>x && x.id).filter(Boolean),
    };
  };

  return json(200, {
    ok:true,
    main: toInfo(gMain),
    templates: toInfo(gTpl),
    hint: 'approxMB 接近上限就容易 PUT 失敗；建議拆分 BIN 或清理歷史。'
  });
};

// ===== 工具區（從 inspections.js 簡化復刻，避免相依） =====
function text(status, body, headers={}){
  return { statusCode: status, headers: cors(headers), body: String(body) };
}
function json(status, obj, headers={}){
  return { statusCode: status, headers: cors(Object.assign({'content-type':'application/json; charset=utf-8'}, headers)), body: JSON.stringify(obj) };
}
function cors(headers={}){
  return Object.assign({
    'access-control-allow-origin':'*',
    'access-control-allow-methods':'GET,POST,OPTIONS,DELETE',
    'access-control-allow-headers':'content-type,x-user,x-pass,x-passcode',
  }, headers);
}
function parseAccounts(s){
  try{ const j = JSON.parse(s||'[]'); return Array.isArray(j)?j:[]; }catch(_){ return []; }
}
function allow(role, roles){ return roles.includes(role||''); }
function authenticate(accounts, passcode, headers){
  const h = normHeaders(headers||{});
  const upUser = (h['x-user']||'').trim();
  const upPass = (h['x-pass']||'').trim();
  const code   = (h['x-passcode']||'').trim();
  // 邏輯：若提供 user/pass，必須在 accounts；否則若提供 passcode，視為 admin；否則拒絕
  if (upUser && upPass){
    const acct = (accounts||[]).find(a => a.user===upUser && a.pwd===upPass);
    if (!acct) return { ok:false, status:401, error:'Bad credentials' };
    const role = acct.role||'viewer';
    return { ok:true, role, user:upUser };
  }
  if (code && code === passcode) return { ok:true, role:'admin', user:'passcode' };
  return { ok:false, status:401, error:'Unauthorized' };
}
function normHeaders(h){
  const o={}; for (const k of Object.keys(h||{})) o[k.toLowerCase()] = h[k]; return o;
}
async function jsonbinGet(binId, apiKey){
  try{
    const r = await fetch(`https://api.jsonbin.io/v3/b/${encodeURIComponent(binId)}/latest`, {
      headers: { 'X-Master-Key': apiKey, 'Content-Type':'application/json' }
    });
    const txt = await r.text();
    let j={}; try{ j = JSON.parse(txt); }catch{}
    if (!r.ok) return { ok:false, status:r.status, text:txt };
    const arr = Array.isArray(j) ? j : (j.record || []);
    return { ok:true, status:r.status, json:arr };
  }catch(e){
    return { ok:false, status:0, text:String(e) };
  }
}
