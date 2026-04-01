// api/apex.js — Anthropic proxy with manual body parsing
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  try {
    let body = {};

    if (req.method === "POST") {
      // Manually collect body chunks — Vercel ESM doesn't auto-parse
      const raw = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", chunk => { data += chunk; });
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      try {
        body = JSON.parse(raw);
      } catch (e) {
        return res.status(400).json({ error: "Invalid JSON body", detail: e.message });
      }
    } else if (req.method === "GET" && req.query.q) {
      try {
        body = JSON.parse(decodeURIComponent(req.query.q));
      } catch (e) {
        // treat as plain text prompt
        body = { messages: [{ role: "user", content: decodeURIComponent(req.query.q) }] };
      }
    }

    const { messages, system, model, max_tokens } = body;
    if (!messages?.length) return res.status(400).json({ error: "messages required" });

    const payload = {
      model:      model      || "claude-haiku-4-5-20251001",
      max_tokens: max_tokens || 800,
      messages,
    };
    if (system) payload.system = system;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({
      error: data?.error?.message || "Anthropic error",
      detail: JSON.stringify(data).slice(0, 200)
    });

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "Proxy error", detail: e.message });
  }
}
