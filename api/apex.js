// api/apex.js — Anthropic API proxy for Apex Capper
// Keeps ANTHROPIC_API_KEY server-side. Allows calls from any origin (file://, localhost, CDN).

export const config = {
  api: { bodyParser: { sizeLimit: '2mb' } },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  try {
    let body = {};

    if (req.method === "POST") {
      // Vercel bodyParser gives us req.body already parsed
      body = req.body || {};
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch(e) {
          return res.status(400).json({ error: "Invalid JSON body", detail: e.message });
        }
      }
    } else if (req.method === "GET" && req.query.q) {
      // GET fallback: ?q=<url-encoded-json>
      try {
        body = JSON.parse(decodeURIComponent(req.query.q));
      } catch(e) {
        // Plain string fallback
        body = { messages: [{ role: "user", content: decodeURIComponent(req.query.q) }] };
      }
    } else {
      return res.status(400).json({ error: "POST with JSON body or GET with ?q= required" });
    }

    const { messages, system, model, max_tokens } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: "messages array required",
        received: typeof body,
        keys: Object.keys(body),
      });
    }

    // Build Anthropic payload — NO web search tool (causes tool_use stop reason, breaks single-turn)
    const payload = {
      model:      model      || "claude-sonnet-4-20250514",
      max_tokens: max_tokens || 2000,
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

    if (!r.ok) {
      console.error("Anthropic error:", r.status, JSON.stringify(data).slice(0, 300));
      return res.status(r.status).json({
        error:  data?.error?.message || `Anthropic error ${r.status}`,
        detail: JSON.stringify(data).slice(0, 300),
      });
    }

    return res.status(200).json(data);

  } catch(e) {
    console.error("apex.js proxy error:", e.message);
    return res.status(500).json({ error: "Proxy error", detail: e.message });
  }
}
