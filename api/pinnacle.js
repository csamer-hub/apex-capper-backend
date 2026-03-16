// api/pinnacle.js — OddsPapi proxy for Pinnacle sharp lines
// Pinnacle is the sharpest book in the world — their line is the benchmark
// Free tier: 500 requests, pre-match only, 6 sports, no props

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const ODDSPAPI_KEY = process.env.ODDSPAPI_KEY;
  if (!ODDSPAPI_KEY) {
    return res.status(500).json({ error: "ODDSPAPI_KEY not configured in environment variables" });
  }

  const { sportId, tournamentId, fixtureId, oddsFormat = "american" } = req.query;

  try {
    let url;

    if (fixtureId) {
      // Get odds for a specific fixture
      url = `https://api.oddspapi.io/v4/odds?fixtureId=${fixtureId}&bookmaker=pinnacle&oddsFormat=${oddsFormat}&apiKey=${ODDSPAPI_KEY}`;
    } else if (tournamentId) {
      // Get odds by tournament
      url = `https://api.oddspapi.io/v4/odds-by-tournaments?tournamentIds=${tournamentId}&bookmaker=pinnacle&oddsFormat=${oddsFormat}&apiKey=${ODDSPAPI_KEY}`;
    } else if (sportId) {
      // Get tournaments for a sport first
      url = `https://api.oddspapi.io/v4/tournaments?sportId=${sportId}&apiKey=${ODDSPAPI_KEY}`;
    } else {
      return res.status(400).json({ error: "Provide sportId, tournamentId, or fixtureId" });
    }

    const response = await fetch(url);
    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `OddsPapi error: ${response.status}`, detail: err });
    }

    const data = await response.json();
    return res.status(200).json({ data, fetchedAt: new Date().toISOString(), oddsFormat });

  } catch (err) {
    console.error("OddsPapi proxy error:", err);
    return res.status(500).json({ error: "Internal server error", detail: err.message });
  }
}
