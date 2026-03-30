// api/apex.js — Anthropic API proxy (GET-based to avoid CORS preflight from file://)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  try {
    // Support both GET (q= param, avoids preflight) and POST (body)
    let messages, system, model, max_tokens;

    if (req.method === "GET") {
      const raw = req.query.q;
      if (!raw) return res.status(400).json({ error: "q param required for GET" });
      const parsed = JSON.parse(decodeURIComponent(raw));
      messages   = parsed.messages;
      system     = parsed.system;
      model      = parsed.model;
      max_tokens = parsed.max_tokens;
    } else {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      if (!body || typeof body !== "object") body = {};
      messages   = body.messages;
      system     = body.system;
      model      = body.model;
      max_tokens = body.max_tokens;
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages required", method: req.method });
    }

    const payload = {
      model:      model      || "claude-sonnet-4-20250514",
      max_tokens: max_tokens || 1024,
      messages,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    };
    if (system) payload.system = system;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta":    "web-search-2025-03-05",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error:  `Anthropic error ${response.status}`,
        detail: data?.error?.message || JSON.stringify(data).slice(0, 300),
      });
    }

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: "Proxy error", detail: err.message });
  }
}
