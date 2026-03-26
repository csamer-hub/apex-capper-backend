// api/odds.js — APEX CAPPER backend proxy
// Handles The Odds API (Fanatics/DK/FD/BetMGM) + OddsPapi (Pinnacle)
// CORS headers applied to EVERY response path — required for Claude artifact iframe

export default async function handler(req, res) {
  // ── CORS — must be set before ANY res.status().json() call ──────────────────
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400"); // cache preflight 24h

  // Handle preflight — must return 200, not 204
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { source } = req.query;

  // ── Route: Pinnacle via OddsPapi ─────────────────────────────────────────────
  if (source === "pinnacle") {
    const ODDSPAPI_KEY = process.env.ODDSPAPI_KEY;
    if (!ODDSPAPI_KEY) {
      return res.status(500).json({ error: "ODDSPAPI_KEY not configured" });
    }

    const { sportId, tournamentId, oddsFormat = "american" } = req.query;

    try {
      let url;
      if (tournamentId) {
        // Fetch odds for a specific tournament
        url = `https://api.oddspapi.com/fixtures?key=${ODDSPAPI_KEY}&tournamentId=${tournamentId}&oddsFormat=${oddsFormat}&bookmakers=pinnacle&include=bookmakerOdds`;
      } else if (sportId) {
        // Fetch tournament list for a sport
        url = `https://api.oddspapi.com/tournaments?key=${ODDSPAPI_KEY}&sportId=${sportId}`;
      } else {
        return res.status(400).json({ error: "Provide sportId or tournamentId" });
      }

      const response = await fetch(url, { headers: { "Accept": "application/json" } });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        return res.status(response.status).json({
          error: `OddsPapi error ${response.status}`,
          detail: errText.slice(0, 200)
        });
      }

      const data = await response.json();
      return res.status(200).json({ data: data.data || data, meta: data.meta || null });

    } catch (err) {
      return res.status(500).json({ error: "Pinnacle fetch failed", detail: err.message });
    }
  }

  // ── Route: The Odds API (Fanatics, DraftKings, FanDuel, BetMGM) ─────────────
  const ODDS_API_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_API_KEY) {
    return res.status(500).json({ error: "ODDS_API_KEY not configured" });
  }

  const {
    sport = "upcoming",
    markets = "h2h,spreads,totals",
    bookmakers = "fanatics,draftkings,fanduel,betmgm",
    oddsFormat = "american",
    dateFormat = "iso",
  } = req.query;

  try {
    const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds`);
    url.searchParams.set("apiKey", ODDS_API_KEY);
    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", markets);
    url.searchParams.set("bookmakers", bookmakers);
    url.searchParams.set("oddsFormat", oddsFormat);
    url.searchParams.set("dateFormat", dateFormat);

    const response = await fetch(url.toString(), {
      headers: { "Accept": "application/json" }
    });

    // Pass through quota headers from The Odds API
    const quotaRemaining = response.headers.get("x-requests-remaining");
    const quotaUsed = response.headers.get("x-requests-used");

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return res.status(response.status).json({
        error: `Odds API error ${response.status}`,
        detail: errText.slice(0, 200)
      });
    }

    const data = await response.json();
    return res.status(200).json({
      data,
      meta: {
        sport,
        markets,
        quotaRemaining: quotaRemaining ? parseInt(quotaRemaining) : null,
        quotaUsed: quotaUsed ? parseInt(quotaUsed) : null,
        timestamp: new Date().toISOString(),
      }
    });

  } catch (err) {
    return res.status(500).json({ error: "Odds fetch failed", detail: err.message });
  }
}
