// netlify/functions/inspections.js


function cors() {
return {
'Access-Control-Allow-Origin': '*',
'Access-Control-Allow-Headers': 'Content-Type, x-passcode',
'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
}
function resp(code, obj) {
return { statusCode: code, headers: cors(), body: JSON.stringify(obj) };
}


async function getList(binId, apiKey) {
const r = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
headers: { 'X-Master-Key': apiKey },
});
const text = await r.text();
if (!r.ok) {
// 回傳空陣列讓流程不中斷（同時可視需要加上日誌或告警）
return [];
}
try {
const data = JSON.parse(text);
// JSONBIN v3 通常是 { record: [...] }
if (Array.isArray(data)) return data;
if (data && Array.isArray(data.record)) return data.record;
if (data && Array.isArray(data.records)) return data.records;
if (data && typeof data === 'object') return [data];
return [];
} catch {
return [];
}
}


async function putList(binId, apiKey, list) {
const r = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
method: 'PUT',
headers: {
'Content-Type': 'application/json',
'X-Master-Key': apiKey,
},
body: JSON.stringify({ record: list }),
});
const text = await r.text();
return r.ok;
}


function dedupById(list) {
const seen = new Set();
const out = [];
for (const item of list) {
const id = item && item.id ? String(item.id) : '';
if (!id) { out.push(item); continue; }
if (!seen.has(id)) { seen.add(id); out.push(item); }
}
return out;
}


async function saveWithRetry(binId, apiKey, newRecord, maxTry = 5) {
for (let i = 0; i < maxTry; i++) {
// 1) 抓最新
const latest = await getList(binId, apiKey);


// 2) 合併（若這筆已存在以 id 判斷，就不重複加）
let merged = dedupById([...latest, newRecord]);


// 3) 寫回
const ok = await putList(binId, apiKey, merged);
if (ok) return true;


// 4) 等一下再重試（每次等久一點）
await sleep(150 * (i + 1));
}
return false;
}


function sleep(ms) {
return new Promise(r => setTimeout(r, ms));
}