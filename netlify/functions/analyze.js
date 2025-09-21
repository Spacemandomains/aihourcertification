// Netlify Function: POST /api/analyze
// Body: { fileUrl: string, filename?: string, useOpenAI?: boolean }
//
// Downloads the JSON from Uploadcare (raw/original URL),
// extracts timestamps, and asks OpenAI to compute total hours.
// Returns ONLY the OpenAI result.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const { fileUrl, filename } = JSON.parse(event.body || '{}');
    if (!fileUrl) return json({ error: 'fileUrl is required' }, 400);

    if (!process.env.OPENAI_API_KEY) {
      return json({ error: 'OPENAI_API_KEY missing in Netlify env vars' }, 400);
    }

    // 1) Fetch JSON from Uploadcare original URL
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) return json({ error: `Failed to fetch file: ${fileRes.status}` }, 400);
    const text = await fileRes.text();

    // 2) Parse JSON or NDJSON to JS object/array
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      try { data = text.trim().split(/\r?\n/).map((l) => JSON.parse(l)); }
      catch { return json({ error: 'File is not valid JSON or NDJSON' }, 400); }
    }

    // 3) Extract timestamps & compact for LLM
    const compact = sampleTimestampsForLLM(data, 1000); // up to 1000 stamps

    // 4) Ask OpenAI to compute total hours, sessions, first/last
    const openai = await askOpenAIForHours(process.env.OPENAI_API_KEY, compact);

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

/* ---------- Helpers ---------- */

function extractTimestamps(any) {
  const out = new Set();
  const KEYS = new Set(['created', 'created_at', 'timestamp', 'ts', 'time', 'date', 'create_time']);

  function visit(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (v == null) continue;
        const lk = k.toLowerCase();
        if (KEYS.has(lk)) {
          const d = toDate(v);
          if (d) out.add(d.toISOString());
        }
        if (typeof v === 'object') visit(v);
      }
      return;
    }
  }

  function toDate(v) {
    if (typeof v === 'string') {
      const d = new Date(v);
      if (!isNaN(d)) return d;
      if (/^\d{10,13}$/.test(v)) return fromUnix(Number(v));
    }
    if (typeof v === 'number') return fromUnix(v);
    return null;
  }

  function fromUnix(n) {
    if (n > 1e12) return new Date(n);        // ms
    if (n > 1e9)  return new Date(n * 1000); // s
    return null;
  }

  visit(any);
  return Array.from(out).map(s => new Date(s)).sort((a,b)=>a-b);
}

function sampleTimestampsForLLM(data, max = 1000) {
  const stamps = extractTimestamps(data).map(d => d.toISOString());
  return { timestamps: stamps.slice(0, max), gap_minutes: 30 };
}

async function askOpenAIForHours(apiKey, compact) {
  const prompt = `
You are given JSON with an array "timestamps" (ISO 8601 strings) sorted earliest->latest and a "gap_minutes" threshold.
A "session" ends when the gap between consecutive timestamps is >= gap_minutes.
Total time = sum over sessions of (last - first). If a session would be zero minutes, count it as 1 minute.
Return STRICT JSON: {"total_hours": number, "sessions": number, "first": isoOrNull, "last": isoOrNull }.
`.trim();

  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: JSON.stringify(compact) }
    ],
    temperature: 0
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${t}`);
  }

  const json = await res.json();
  const text = json.choices?.[0]?.message?.content?.trim() || "{}";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
