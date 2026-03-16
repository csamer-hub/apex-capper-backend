// api/tournaments.js — OddsPapi tournament lookup
// Use this to find tournament IDs for a sport, then pass to /api/pinnacle

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const ODDSPAPI_KEY = process.env.ODDSPAPI_KEY;
  if (!ODDSPAPI_KEY) {
    return res.status(500).json({ error: "ODDSPAPI_KEY not configured" });
  }

  const { sportId = "10" } = req.query; // default to soccer (10)

  try {
    const url = `https://api.oddspapi.io/v4/tournaments?sportId=${sportId}&apiKey=${ODDSPAPI_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    return res.status(200).json({ data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
