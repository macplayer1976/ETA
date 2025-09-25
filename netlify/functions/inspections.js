// netlify/functions/inspections.js
exports.handler = async (event) => {
  const ENV = process.env || {};
  const API_KEY   = ENV.JSONBIN_API_KEY;
  const BIN_ID    = ENV.JSONBIN_BIN_ID;
  const PASSCODE  = ENV.PASSCODE;

  const BASE_ACCOUNTS = parseAccounts(ENV.ACCOUNT_JSON || ENV.ACCOUNTS_JSON || ENV.ACCOUNT_JSON);
  const ACCOUNTS = buildAccounts(BASE_ACCOUNTS, {
    INPUT_USERS_CSV:  ENV.INPUT_USERS_CSV || '',
    INPUT_FIXED_PWD:  ENV.INPUT_FIXED_PWD || '',
    VIEWER_USERS_CSV: ENV.VIEWER_USERS_CSV || '',
    VIEWER_FIXED_PWD: ENV.VIEWER_FIXED_PWD || '',
  });

  if (event.httpMethod === 'OPTIONS') return text(200, 'OK');

  const qs = event.queryStringParameters || {};

  if (event.httpMethod === 'GET' && (qs.health === '1' || qs.health === 'true')) {
    return json(200, { ok: true, runtime: process.version, hasFetch: typeof fetch === 'function' });
  }

  if (!API_KEY || !BIN_ID) return json(500, { error: 'Missing env: JSONBIN_API_KEY / JSONBIN_BIN_ID' });

  const auth = authenticate(ACCOUNTS, PASSCODE, event.headers);
  if (!auth.ok) return json(auth.status || 401, { ok:false, error: auth.error || 'Unauthorized' });

  if (event.httpMethod === 'GET' && (qs.auth === '1' || qs.auth === 'true')) {
    return json(200, { ok: true, mode: auth.mode, role: auth.role, user: auth.user || '' });
  }

  if (event.httpMethod === 'GET' && (qs.templates === '1' || qs.templates === 'true')) {
    if (!allow(auth.role, ['admin', 'viewer', 'input'])) return json(403, { ok:false, error:'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    const list = listFromJson(g.json).filter(x => x && x.type === 'template');
    return json(200, { ok:true, templates: list });
  }

  if (event.httpMethod === 'POST' && (qs.template === '1' || qs.template === 'true')) {
    if (!allow(auth.role, ['admin', 'input'])) return json(403, { ok:false, error:'Forbidden' });
    let body = {}; try { body = JSON.parse(event.body || '{}'); } catch {}
    const t = sanitizeTemplate(body.template || body.record || {}, auth.user);
    if (!t.ok) return json(400, { ok:false, error: t.error || 'Invalid template' });
    const rec = t.data;
    const result = await saveWithRetry(BIN_ID, API_KEY, rec, 5);
    if (!result.ok) return json(500, { ok:false, error:'Failed to save template', lastStatus: result.lastStatus, lastText: result.lastText });
    return json(200, { ok:true, id: rec.id });
  }

  if (event.httpMethod === 'GET' && (qs.diag === '1' || qs.diag === 'true')) {
    if (!allow(auth.role, ['admin', 'viewer'])) return json(403, { ok:false, error:'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    const list = listFromJson(g.json).filter(x => x.type !== 'template');
    const last = list.length ? list[list.length-1] : null;
    return json(200, { ok:true, count:list.length, last: last ? { id:last.id, timestamp:last.timestamp, inspector:last.inspector, hasMeasurements:Array.isArray(last.measurements) } : null });
  }

  if (event.httpMethod === 'GET') {
    if (!allow(auth.role, ['admin', 'viewer'])) return json(403, { ok:false, error:'Forbidden' });
    const g = await jsonbinGet(BIN_ID, API_KEY);
    if (!g.ok) return json(g.status || 500, { ok:false, error:'JSONBIN GET failed', detail:g.text });
    return json(200, listFromJson(g.json));
  }

  if (event.httpMethod === 'POST') {
    if (!allow(auth.role, ['admin', 'input'])) return json(403, { ok:false, error:'Forbidden' });
    let body = {}; try { body = JSON.parse(event.body || '{}'); } catch {}
    if (!body || !body.record) return json(400, { ok:false, error:'Missing record' });
    const rec = sanitizeRecord(body.record, auth.user);
    const result = await saveWithRetry(BIN_ID, API_KEY, rec, 5);
    if (!result.ok) return json(500, { ok:false, error:'Failed to save', lastStatus: result.lastStatus, lastText: result.lastText });
    return json(200, { ok:true, id: rec.id });
  }

  if (event.httpMethod === 'DELETE') {
    if (!allow(auth.role, ['admin'])) return json(403, { ok:false, error:'Forbidden' });
    const id = (event.queryStringParameters || {}).id || '';
    if (!id) return json(400, { ok:false, error:'Missing id' });
    const result = await deleteWithRetry(BIN_ID, API_KEY, id, 5);
    if (!result.ok) return json(result.lastStatus || 500, { ok:false, error:'Failed to delete', lastStatus: result.lastStatus, lastText: result.lastText });
    return json(200, { ok:true, deleted: result.deleted ? 1 : 0, id });
  }

  return json(405, { ok:false, error:'Method Not Allowed' });

  function headers() { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, x-passcode, x-user, x-pass', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', }; }
  function json(code, obj) { return { statusCode: code, headers: headers(), body: JSON.stringify(obj) }; }
  function text(code, s)    { return { statusCode: code, headers: headers(), body: s }; }
};

function buildAccounts(baseAccounts, env) {
  const base = Array.isArray(baseAccounts) ? baseAccounts : [];
  const admins = base.filter(a => (a.role || '').toLowerCase() === 'admin');
  const parseCsv = (s) => String(s || '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
  const inputUsers  = parseCsv(env.INPUT_USERS_CSV);
  const viewerUsers = parseCsv(env.VIEWER_USERS_CSV);
  const inputPwd    = String(env.INPUT_FIXED_PWD || '');
  const viewerPwd   = String(env.VIEWER_FIXED_PWD || '');
  if ((inputUsers.length && inputPwd) || (viewerUsers.length && viewerPwd)) {
    const out = [...admins];
    for (const u of inputUsers)  out.push({ user: u, pwd: inputPwd,  role: 'input'  });
    for (const u of viewerUsers) out.push({ user: u, pwd: viewerPwd, role: 'viewer' });
    const seen = new Set(); const uniq = [];
    for (const a of out){ const k = (a.role||'').toLowerCase()+'::'+String(a.user||''); if (!seen.has(k)){ seen.add(k); uniq.push(a); } }
    return uniq;
  }
  return base;
}
function parseAccounts(raw) { try { if (!raw) return []; let s = String(raw); if (/^base64:/i.test(s)) s = Buffer.from(s.slice(7), 'base64').toString('utf8'); const arr = JSON.parse(s); return Array.isArray(arr) ? arr : []; } catch { return []; } }
function authenticate(accounts, passcodeEnv, headers) { const h = headers || {}; const user = (h['x-user'] || h['X-User'] || '').trim(); const pass = (h['x-pass'] || h['X-Pass'] || '').trim(); const team = (h['x-passcode'] || h['X-Passcode'] || '').trim(); if (accounts && accounts.length) { const found = accounts.find(a => String(a.user) === user && String(a.pwd) === pass); if (!found) return { ok:false, status:401, error:'Unauthorized' }; const role = (found.role || 'input').toLowerCase(); return { ok:true, mode:'accounts', role, user }; } if (!passcodeEnv || team !== passcodeEnv) { return { ok:false, status:401, error:'Unauthorized' }; } return { ok:true, mode:'passcode', role:'admin', user:user || '' }; }
function allow(role, list) { return list.includes((role || '').toLowerCase()); }

async function jsonbinGet(binId, apiKey) { try { const r = await fetch('https://api.jsonbin.io/v3/b/' + binId + '/latest', { headers: { 'X-Master-Key': apiKey } }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) { json = null; } return { ok: r.ok, status: r.status, text, json }; } catch (e) { return { ok: false, status: 0, text: String(e) }; } }
async function jsonbinPut(binId, apiKey, list) { try { const r = await fetch('https://api.jsonbin.io/v3/b/' + binId, { method:'PUT', headers:{ 'Content-Type':'application/json', 'X-Master-Key': apiKey }, body: JSON.stringify({ record: list }) }); const text = await r.text(); return { ok:r.ok, status:r.status, text }; } catch (e) { return { ok:false, status:0, text:String(e) }; } }

function listFromJson(data){ if (!data) return []; if (Array.isArray(data)) return data; if (data.record) return listFromJson(data.record); if (data.records) return listFromJson(data.records); if (data.id && data.timestamp) return [data]; return []; }
function dedupById(arr){ const seen = new Set(); const out = []; for (const x of arr){ const id = String(x && x.id || ''); if (!id || seen.has(id)) continue; seen.add(id); out.push(x); } return out; }
function sanitizeRecord(r, who){ try{ const now = new Date().toISOString(); const id = r.id && String(r.id) || `INS-${now.replace(/\D/g,'').slice(0,14)}-${Math.floor(100+Math.random()*900)}`; return { id, timestamp: r.timestamp || now, inspector: r.inspector || who || '', supplier: r.supplier || '', supplierEn: r.supplierEn || '', supplierCode: r.supplierCode || '', partNo: r.partNo || '', drawingNo: r.drawingNo || '', revision: r.revision || '', process: r.process || r.processCode || '', orderNo: r.orderNo || '', lotNo: r.lotNo || '', material: r.material || '', spec: r.spec || '', category: r.category || '', notes: r.notes || '', appearance: Array.isArray(r.appearance) ? r.appearance : [], measurements: Array.isArray(r.measurements) ? r.measurements : [], overallResult: r.overallResult || '' }; }catch{ return r; } }
function sanitizeTemplate(t, who){ try{ const now = new Date().toISOString(); const id = t.id && String(t.id) || `TPL-${now.replace(/\D/g,'').slice(0,14)}-${Math.floor(100+Math.random()*900)}`; const key = t.key && typeof t.key === 'object' ? t.key : {}; const keyClean = {}; ['supplier','partNo','drawingNo','material','spec','category','process'].forEach(k => { const v = String((key[k] ?? t[k] ?? '')).trim(); if (v) keyClean[k]=v; }); const ms = Array.isArray(t.measurements) ? t.measurements.map(d => ({ code: String(d.code||''), name: String(d.name||''), nom: d.nom===''||d.nom===null? '' : Number(d.nom), lo: d.lo===''||d.lo===null ? '' : Number(d.lo), hi: d.hi===''||d.hi===null ? '' : Number(d.hi), })) : []; return { ok:true, data:{ id, type:'template', timestamp: now, owner: who || '', key: keyClean, appearance: Array.isArray(t.appearance) ? t.appearance.slice(0,5) : [], measurements: ms }}; }catch(e){ return { ok:false, error:String(e) }; } }
async function saveWithRetry(binId, apiKey, record, maxTry){ for (let i=0;i<(maxTry||3);i++){ const g = await jsonbinGet(binId, apiKey); if (!g.ok) continue; let list = listFromJson(g.json); list = dedupById(list); list.push(record); const p = await jsonbinPut(binId, apiKey, list); if (p.ok) return { ok:true }; } return { ok:false, lastStatus:0, lastText:'PUT failed' }; }
async function deleteWithRetry(binId, apiKey, id, maxTry){ for (let i=0;i<(maxTry||3);i++){ const g = await jsonbinGet(binId, apiKey); if (!g.ok) continue; let list = listFromJson(g.json); list = list.filter(x => String(x && x.id || '') !== String(id || '')); const p = await jsonbinPut(binId, apiKey, list); if (p.ok) return { ok:true, deleted:true }; } return { ok:false, lastStatus:0, lastText:'PUT failed' }; }
