// Netlify Function: POST /api/analyze
// Body: { fileUrl: string, filename?: string }
// Downloads the JSON from Uploadcare (public CDN) and asks OpenAI to compute total hours.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  try {
    const { fileUrl, filename } = JSON.parse(event.body || '{}');
    if (!fileUrl) return json({ error: 'fileUrl is required' }, 400);

    const OPENAI = process.env.OPENAI_API_KEY;
    if (!OPENAI) return json({ error: 'OPENAI_API_KEY missing in Netlify env vars' }, 400);

    // Fetch JSON from Uploadcare original URL
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) return json({ error: `Failed to fetch file: ${fileRes.status}` }, 400);
    const text = await fileRes.text();

    // Parse JSON or NDJSON
    let data;
    try { data = JSON.parse(text); }
    catch {
      try { data = text.trim().split(/\r?\n/).map(l => JSON.parse(l)); }
      catch { return json({ error: 'File is not valid JSON or NDJSON' }, 400); }
    }

    // Compact timestamps for the model
    const compact = sampleTimestampsForLLM(data, 1000);

    // Ask OpenAI
    const openai = await askOpenAIForHours(OPENAI, compact);

    return json({ openai, filename, source: fileUrl });
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

// ---- helpers ----
function extractTimestamps(any) {
  const out = new Set();
  const KEYS = new Set(['created','created_at','timestamp','ts','time','date','create_time']);
  (function visit(n) {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (typeof n === 'object') {
      for (const [k,v] of Object.entries(n)) {
        if (v == null) continue;
        const lk = k.toLowerCase();
        if (KEYS.has(lk)) {
          const d = toDate(v);
          if (d) out.add(d.toISOString());
        }
        if (typeof v === 'object') visit(v);
      }
    }
  })(any);
  return Array.from(out).map(s => new Date(s)).sort((a,b)=>a-b);
}
function toDate(v){
  if (typeof v === 'string') { const d = new Date(v); if (!isNaN(d)) return d; if (/^\d{10,13}$/.test(v)) return fromUnix(+v); }
  if (typeof v === 'number') return fromUnix(v);
  return null;
}
function fromUnix(n){ if (n>1e12) return new Date(n); if (n>1e9) return new Date(n*1000); return null; }
function sampleTimestampsForLLM(data, max=1000){ const stamps = extractTimestamps(data).map(d=>d.toISOString()); return { timestamps: stamps.slice(0,max), gap_minutes: 30 }; }

async function askOpenAIForHours(apiKey, compact) {
  const prompt = `You are given JSON with an array "timestamps" (ISO 8601 strings) sorted earliest->latest and a "gap_minutes" threshold.
A "session" ends when the gap between consecutive timestamps is >= gap_minutes.
Total time = sum over sessions of (last - first). If a session would be zero minutes, count it as 1 minute.
Return STRICT JSON: {"total_hours": number, "sessions": number, "first": isoOrNull, "last": isoOrNull }.`;

  const body = {
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: JSON.stringify(compact) }
    ]
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`OpenAI error ${r.status}: ${t}`); }
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content?.trim() || "{}";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
