// netlify/functions/inspections.js
// Accounts-based auth + passcode fallback. Provides inspection CRUD (list/create)
// and simple template CRUD on JSONBin.
exports.handler = async (event) => {
  const ENV = process.env || {};
  const API_KEY  = ENV.JSONBIN_API_KEY;
  const BIN_ID   = ENV.JSONBIN_BIN_ID;
  const PASSCODE = ENV.PASSCODE;

  // Templates bin (optional; required for cloud templates)
  const TPL_BIN_ID = ENV.JSONBIN_TPL_BIN_ID || ENV.JSONBIN_TPL_ID || '';

  if (!API_KEY || !BIN_ID) {
    return json(500, { ok:false, error: 'Missing env: JSONBIN_API_KEY / JSONBIN_BIN_ID' });
  }

  // Accounts from ACCOUNTS_JSON + ENV expansions
  const BASE_ACCOUNTS = parseAccounts(ENV.ACCOUNTS_JSON);
  const ACCOUNTS = buildAccounts(BASE_ACCOUNTS, {
    INPUT_USERS_CSV:  ENV.INPUT_USERS_CSV  || '',
    INPUT_FIXED_PWD:  ENV.INPUT_FIXED_PWD  || '',
    VIEWER_USERS_CSV: ENV.VIEWER_USERS_CSV || '',
    VIEWER_FIXED_PWD: ENV.VIEWER_FIXED_PWD || ''
  });

  const qs = event.queryStringParameters || {};

  // Preflight
  if (event.httpMethod === 'OPTIONS') return json(200, { ok:true });

  // Health (no auth)
  if (event.httpMethod === 'GET' && (qs.health === '1' || qs.health === 'true')) {
    return json(200, { ok:true, runtime: process.version });
  }

  // Auth
  const auth = authenticate(ACCOUNTS, PASSCODE, event.headers || {});
  if (!auth.ok) return json(auth.status || 401, { ok:false, error: auth.error || 'Unauthorized' });

  // Return who am I
  if (event.httpMethod === 'GET' && (qs.auth === '1' || qs.auth === 'true')) {
    return json(200, { ok:true, mode: auth.mode, role: auth.role, user: auth.user || '' });
  }

  // ---- Template APIs ----
  if (qs.template === '1' || qs.tpl === '1') {
    if (!TPL_BIN_ID) {
      return json(500, { ok:false, error: 'Missing env: JSONBIN_TPL_BIN_ID' });
    }

    if (event.httpMethod === 'GET') {
      // list (admin/viewer/input can view)
      if (!allow(auth.role, ['admin','viewer','input'])) return json(403, { ok:false, error:'Forbidden' });
      const g = await jsonbinGet(TPL_BIN_ID, API_KEY);
      if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
      const list = listFromJson(g.json);
      return json(200, { ok:true, templates: list });
    }

    if (event.httpMethod === 'POST') {
      if (!allow(auth.role, ['admin','input'])) return json(403, { ok:false, error:'Forbidden' });
      let body = parseJSON(event.body);
      const tpl = body && body.template;
      if (!tpl) return json(400, { ok:false, error:'Missing template' });

      const g = await jsonbinGet(TPL_BIN_ID, API_KEY);
      if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
      const list = listFromJson(g.json);

      const now = new Date();
      const id = 'TPL-' + now.toISOString().replace(/[-:T]/g,'').slice(0,14) + '-' + Math.floor(100+Math.random()*900);
      const item = {
        id,
        createdBy: auth.user || '',
        role: auth.role,
        savedAt: now.toISOString(),
        keys: tpl.keys || {},
        measures: Array.isArray(tpl.measures) ? tpl.measures : []
      };
      list.push(item);
      const p = await jsonbinPut(TPL_BIN_ID, API_KEY, list);
      if (!p.ok) return json(p.status || 500, { ok:false, error:'JSONBIN PUT failed', detail:p.text });
      return json(200, { ok:true, id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!allow(auth.role, ['admin','input'])) return json(403, { ok:false, error:'Forbidden' });
      const id = (qs.id || '').trim();
      if (!id) return json(400, { ok:false, error:'Missing id' });
      const g = await jsonbinGet(TPL_BIN_ID, API_KEY);
      if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
      let list = listFromJson(g.json);
      const idx = list.findIndex(x => String(x.id) === id);
      if (idx === -1) return json(404, { ok:false, error:'Not found' });
      // Only owner or admin can delete
      if (!(auth.role === 'admin' || (list[idx].createdBy && list[idx].createdBy === auth.user))) {
        return json(403, { ok:false, error:'Forbidden' });
      }
      list.splice(idx,1);
      const p = await jsonbinPut(TPL_BIN_ID, API_KEY, list);
      if (!p.ok) return json(p.status || 500, { ok:false, error:'JSONBIN PUT failed', detail:p.text });
      return json(200, { ok:true, deleted:1, id });
    }

    return json(405, { ok:false, error:'Method Not Allowed' });
  }

  // ---- Inspection list (GET; admin/viewer) ----
  if (event.httpMethod === 'GET') {
    if (!allow(auth.role, ['admin','viewer'])) return json(403, { ok:false, error:'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    return json(200, listFromJson(g.json));
  }

  // ---- Create inspection (POST; input/admin) ----
  if (event.httpMethod === 'POST') {
    if (!allow(auth.role, ['admin','input'])) return json(403, { ok:false, error:'Forbidden' });
    const body = parseJSON(event.body);
    const rec = body && body.record;
    if (!rec) return json(400, { ok:false, error:'Missing record' });

    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    let list = listFromJson(g.json);

    // Dedup by id
    list = list.filter(x => x && x.id !== rec.id);
    list.push(rec);

    const p = await jsonbinPut(BIN_ID, API_KEY, list);
    if (!p.ok) return json(p.status || 500, { ok:false, error:'JSONBIN PUT failed', detail:p.text });
    return json(200, { ok:true, id: rec.id });
  }

  // ---- Delete inspection (DELETE; admin only) ----
  if (event.httpMethod === 'DELETE') {
    if (!allow(auth.role, ['admin'])) return json(403, { ok:false, error:'Forbidden' });
    const id = (qs.id || '').trim();
    if (!id) return json(400, { ok:false, error:'Missing id' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    let list = listFromJson(g.json);
    const before = list.length;
    list = list.filter(x => String(x.id) !== id);
    const p = await jsonbinPut(BIN_ID, API_KEY, list);
    if (!p.ok) return json(p.status || 500, { ok:false, error:'JSONBIN PUT failed', detail:p.text });
    return json(200, { ok:true, deleted: before - list.length });
  }

  return json(405, { ok:false, error:'Method Not Allowed' });

  // ---------------- Utilities ----------------
  function parseJSON(s){ try{ return JSON.parse(s||''); }catch{ return null; } }
  function headers() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-passcode, x-user, x-pass',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    };
  }
  function json(code, obj){ return { statusCode: code, headers: headers(), body: JSON.stringify(obj) }; }
  function allow(role, roles){ return roles.includes(role || ''); }
  function parseAccounts(str){
    try{
      if (!str) return [];
      const arr = JSON.parse(str);
      return Array.isArray(arr) ? arr.map(x=>({ user:String(x.user||'').trim(), pwd:String(x.pwd||'').trim(), role:String(x.role||'').trim() })) : [];
    }catch{ return []; }
  }
  function buildAccounts(base, envs){
    const out = Array.isArray(base) ? base.slice() : [];
    const addFromCsv = (csv, role, pwd) => {
      (String(csv||'').split(',').map(s=>s.trim()).filter(Boolean)).forEach(u => {
        out.push({ user:u, pwd: String(pwd||'').trim(), role });
      });
    };
    addFromCsv(envs.INPUT_USERS_CSV,  'input',  envs.INPUT_FIXED_PWD);
    addFromCsv(envs.VIEWER_USERS_CSV, 'viewer', envs.VIEWER_FIXED_PWD);
    return out;
  }
  function authenticate(accounts, passcode, headers){
    const h = lowerKeys(headers||{});
    const user = (h['x-user']||'').trim();
    const pass = (h['x-pass']||'').trim();
    const psc  = (h['x-passcode']||'').trim();

    // accounts mode
    const acc = (accounts||[]).find(a => a.user===user && a.pwd===pass);
    if (acc) return { ok:true, mode:'accounts', role:acc.role, user:acc.user };

    // fallback passcode mode
    if (passcode && psc && passcode === psc) return { ok:true, mode:'passcode', role:'admin', user: user || 'passcode' };

    return { ok:false, status:401, error:'Unauthorized' };
  }
  function lowerKeys(obj){ const o={}; Object.keys(obj||{}).forEach(k=>o[k.toLowerCase()] = obj[k]); return o; }

  // JSONBin helpers
  async function jsonbinGet(binId, key){
    const r = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, { headers:{ 'X-Master-Key': key } });
    const text = await r.text(); let j=null; try{ j=JSON.parse(text);}catch{}
    const arr = j && j.record ? j.record : j;
    return { ok:r.ok, status:r.status, text, json: arr };
  }
  async function jsonbinPut(binId, key, data){
    const r = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
      method:'PUT',
      headers:{ 'Content-Type':'application/json', 'X-Master-Key': key },
      body: JSON.stringify(Array.isArray(data)?data:[].concat(data||[]))
    });
    const text = await r.text();
    return { ok:r.ok, status:r.status, text };
  }
  function listFromJson(json){
    if (Array.isArray(json)) return json;
    if (json && Array.isArray(json.records)) return json.records;
    if (json && Array.isArray(json.templates)) return json.templates;
    return [];
  }
};
