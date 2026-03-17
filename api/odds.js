// api/odds.js — ALL odds sources consolidated
// source=fanatics (default) | source=pinnacle
// Fanatics: The Odds API (ODDS_API_KEY)
// Pinnacle: OddsPapi (ODDSPAPI_KEY)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { source = "fanatics" } = req.query;

  // ── FANATICS / THE ODDS API ───────────────────────────────────────────────
  if (source === "fanatics" || source === "odds") {
    const ODDS_API_KEY = process.env.ODDS_API_KEY;
    if (!ODDS_API_KEY) return res.status(500).json({ error: "ODDS_API_KEY not configured" });

    const { sport = "upcoming", markets = "h2h,spreads,totals",
            regions = "us", bookmakers = "fanduel,draftkings,fanatics,betmgm",
            eventId, oddsFormat = "american", dateFormat = "iso" } = req.query;

    try {
      let url;
      if (eventId) {
        url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds?` +
          new URLSearchParams({ apiKey: ODDS_API_KEY, markets, regions, bookmakers, oddsFormat, dateFormat });
      } else {
        url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?` +
          new URLSearchParams({ apiKey: ODDS_API_KEY, markets, regions, bookmakers, oddsFormat, dateFormat });
      }
      const r = await fetch(url);
      const quotaRemaining = r.headers.get("x-requests-remaining");
      const quotaUsed = r.headers.get("x-requests-used");
      if (!r.ok) return res.status(r.status).json({ error: `Odds API error: ${r.status}`, detail: await r.text() });
      const data = await r.json();
      return res.status(200).json({ data, meta: { quotaRemaining: quotaRemaining ? parseInt(quotaRemaining) : null,
        quotaUsed: quotaUsed ? parseInt(quotaUsed) : null, sport, markets, bookmakers, fetchedAt: new Date().toISOString() } });
    } catch (err) {
      return res.status(500).json({ error: "Odds API error", detail: err.message });
    }
  }

  // ── SPORTS LIST (The Odds API) ────────────────────────────────────────────
  if (source === "sports") {
    const ODDS_API_KEY = process.env.ODDS_API_KEY;
    if (!ODDS_API_KEY) return res.status(500).json({ error: "ODDS_API_KEY not configured" });
    try {
      const r = await fetch(`https://api.the-odds-api.com/v4/sports?apiKey=${ODDS_API_KEY}&all=true`);
      const data = await r.json();
      return res.status(200).json({ data });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── PINNACLE / ODDSPAPI ───────────────────────────────────────────────────
  if (source === "pinnacle") {
    const ODDSPAPI_KEY = process.env.ODDSPAPI_KEY;
    if (!ODDSPAPI_KEY) return res.status(500).json({ error: "ODDSPAPI_KEY not configured" });

    const { sportId, tournamentId, fixtureId, oddsFormat = "american" } = req.query;

    try {
      let url;
      if (fixtureId) {
        url = `https://api.oddspapi.io/v4/odds?fixtureId=${fixtureId}&bookmaker=pinnacle&oddsFormat=${oddsFormat}&apiKey=${ODDSPAPI_KEY}`;
      } else if (tournamentId) {
        url = `https://api.oddspapi.io/v4/odds-by-tournaments?tournamentIds=${tournamentId}&bookmaker=pinnacle&oddsFormat=${oddsFormat}&apiKey=${ODDSPAPI_KEY}`;
      } else if (sportId) {
        url = `https://api.oddspapi.io/v4/tournaments?sportId=${sportId}&apiKey=${ODDSPAPI_KEY}`;
      } else {
        return res.status(400).json({ error: "Provide sportId, tournamentId, or fixtureId" });
      }
      const r = await fetch(url);
      if (!r.ok) return res.status(r.status).json({ error: `OddsPapi error: ${r.status}`, detail: await r.text() });
      const data = await r.json();
      return res.status(200).json({ data, fetchedAt: new Date().toISOString(), oddsFormat });
    } catch (err) {
      return res.status(500).json({ error: "OddsPapi error", detail: err.message });
    }
  }

  return res.status(400).json({
    error: "Invalid source",
    validSources: ["fanatics", "pinnacle", "sports"],
    examples: [
      "/api/odds?source=fanatics&sport=basketball_nba&markets=h2h,spreads,totals",
      "/api/odds?source=pinnacle&sportId=10",
      "/api/odds?source=pinnacle&tournamentId=17",
      "/api/odds?source=sports",
    ]
  });
}
