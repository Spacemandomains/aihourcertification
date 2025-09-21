const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  try {
    const { fileUrl, filename } = JSON.parse(event.body || '{}');
    if (!fileUrl) return json({ error: 'fileUrl is required' }, 400);

    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) return json({ error: `Failed to fetch file: ${fileRes.status}` }, 400);

    const text = await fileRes.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      try {
        data = text.trim().split(/\r?\n/).map(line => JSON.parse(line));
      } catch {
        return json({ error: 'File is not valid JSON', preview: text.slice(0,200), length: text.length }, 400);
      }
    }

    const stamps = extractTimestamps(data);
    const result = calcSessions(stamps, 30); // 30-minute gap

    return json({ openai: result, filename, source: fileUrl });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
};

function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
    body: JSON.stringify(obj)
  };
}

const TIMESTAMP_KEYS = new Set([
  'create_time','created','created_at','timestamp','ts',
  'time','date','update_time','modified_at','last_activity_time'
]);

function extractTimestamps(any) {
  const out = new Set();
  function toDate(v){
    if (typeof v === 'number') {
      if (v > 1e12) return new Date(v);
      if (v > 1e9) return new Date(v*1000);
    }
    if (typeof v === 'string') {
      if (/^\d{10,13}(\.\d+)?$/.test(v)) {
        const n = Number(v);
        if (n > 1e12) return new Date(n);
        if (n > 1e9) return new Date(n*1000);
      }
      const d = new Date(v);
      if (!isNaN(d)) return d;
    }
    return null;
  }
  function visit(n){
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (typeof n === 'object') {
      for (const [k,v] of Object.entries(n)){
        if (TIMESTAMP_KEYS.has(k.toLowerCase())) {
          const d = toDate(v);
          if (d) out.add(d.toISOString());
        }
        if (typeof v === 'object') visit(v);
      }
    }
  }
  visit(any);
  return Array.from(out).map(s=>new Date(s)).sort((a,b)=>a-b);
}

function calcSessions(timestamps, gapMinutes=30){
  const gapMs = gapMinutes*60*1000;
  if (!timestamps.length) return { total_hours:0, sessions:0, first:null, last:null };

  let sessions=0, totalMs=0;
  let sessionStart = timestamps[0];
  let prev = timestamps[0];
  let first = timestamps[0];
  let last = timestamps[0];

  for (let i=1; i<timestamps.length; i++){
    const t = timestamps[i];
    if (t - prev >= gapMs){
      sessions++;
      totalMs += Math.max(prev - sessionStart, 60*1000);
      sessionStart = t;
    }
    prev = t;
    last = t;
  }
  sessions++;
  totalMs += Math.max(last - sessionStart, 60*1000);

  return {
    total_hours: totalMs / 3_600_000,
    sessions,
    first,
    last
  };
}
