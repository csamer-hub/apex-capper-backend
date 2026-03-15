// api/odds.js — Vercel serverless function
// Proxies requests to The Odds API — keeps your API key server-side and secret

export default async function handler(req, res) {
  // CORS headers — allows your APEX app to call this endpoint
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const ODDS_API_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_API_KEY) {
    return res.status(500).json({ error: "ODDS_API_KEY not configured in environment variables" });
  }

  // Pull query params forwarded from the APEX app
  const {
    sport = "upcoming",       // e.g. americanfootball_nfl, soccer_usa_mls, baseball_mlb
    markets = "h2h,spreads,totals",
    regions = "us",
    bookmakers = "fanduel,draftkings,fanatics,betmgm,pinnacle",
    eventId,                  // optional — fetch odds for a specific game
    oddsFormat = "american",
    dateFormat = "iso",
  } = req.query;

  try {
    let url;

    if (eventId) {
      // Fetch odds for a specific event
      url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds?` +
        new URLSearchParams({ apiKey: ODDS_API_KEY, markets, regions, bookmakers, oddsFormat, dateFormat });
    } else {
      // Fetch upcoming odds for a sport
      url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?` +
        new URLSearchParams({ apiKey: ODDS_API_KEY, markets, regions, bookmakers, oddsFormat, dateFormat });
    }

    const oddsRes = await fetch(url);

    // Forward remaining API quota info to the client
    const quotaRemaining = oddsRes.headers.get("x-requests-remaining");
    const quotaUsed = oddsRes.headers.get("x-requests-used");

    if (!oddsRes.ok) {
      const errText = await oddsRes.text();
      return res.status(oddsRes.status).json({
        error: `Odds API error: ${oddsRes.status}`,
        detail: errText,
      });
    }

    const data = await oddsRes.json();

    return res.status(200).json({
      data,
      meta: {
        quotaRemaining: quotaRemaining ? parseInt(quotaRemaining) : null,
        quotaUsed: quotaUsed ? parseInt(quotaUsed) : null,
        sport,
        markets,
        bookmakers,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("Odds proxy error:", err);
    return res.status(500).json({ error: "Internal server error", detail: err.message });
  }
}
