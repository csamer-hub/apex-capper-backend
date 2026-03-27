// api/apex.js — Anthropic API proxy
// Keeps ANTHROPIC_API_KEY server-side, allows calls from any origin

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in environment variables" });
  }

  try {
    const body = req.body;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05"
      },
      body: JSON.stringify({
        model: body.model || "claude-sonnet-4-20250514",
        max_tokens: body.max_tokens || 1000,
        system: body.system || "",
        messages: body.messages || [],
        tools: [{ type: "web_search_20250305", name: "web_search" }]
      })
    });

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      return res.status(response.status).json({ error: `Anthropic error ${response.status}`, detail: err.slice(0, 300) });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: "Proxy error", detail: err.message });
  }
}
