// api/odds.js — APEX CAPPER backend proxy
// Handles The Odds API — public US books (Fanatics/DK/FD/BetMGM) AND the
// sharp reference book Pinnacle. Pinnacle is NOT a separate provider: it is
// a bookmaker INSIDE The Odds API, served under the "eu" region. So both the
// public-book branch and the Pinnacle branch call the same the-odds-api.com
// endpoint with the same key — they just ask for different regions/books.
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

  // ── Route: Pinnacle (sharp book) via The Odds API, "eu" region ──────────────
  if (source === "pinnacle") {
    // Pinnacle uses the SAME The Odds API account. Prefer the main key (known
    // good); fall back to ODDSPAPI_KEY if that's the one holding the key value.
    const KEY = process.env.ODDS_API_KEY || process.env.ODDSPAPI_KEY;
    if (!KEY) {
      return res.status(500).json({ error: "No Odds API key configured (ODDS_API_KEY / ODDSPAPI_KEY)" });
    }

    // Accept a standard Odds API sport key (e.g. baseball_mlb). For backward
    // compatibility map a few legacy numeric sportIds that older callers sent.
    const SPORT_ID_MAP = {
      "1": "americanfootball_nfl",
      "2": "basketball_nba",
      "3": "baseball_mlb",
      "4": "icehockey_nhl",
      "americanfootball_ncaaf": "americanfootball_ncaaf",
    };
    const sport =
      req.query.sport ||
      SPORT_ID_MAP[String(req.query.sportId || "")] ||
      "baseball_mlb";
    const markets = req.query.markets || "h2h,spreads,totals";
    const oddsFormat = req.query.oddsFormat || "american";

    try {
      const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds`);
      url.searchParams.set("apiKey", KEY);
      url.searchParams.set("regions", "eu");          // Pinnacle is an EU-region book
      url.searchParams.set("bookmakers", "pinnacle");
      url.searchParams.set("markets", markets);
      url.searchParams.set("oddsFormat", oddsFormat);
      url.searchParams.set("dateFormat", "iso");

      const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
      const quotaRemaining = response.headers.get("x-requests-remaining");
      const quotaUsed = response.headers.get("x-requests-used");

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        return res.status(response.status).json({
          error: `Odds API (pinnacle) error ${response.status}`,
          detail: errText.slice(0, 200),
        });
      }

      const data = await response.json();
      // Keep only games that actually carry a Pinnacle entry.
      const withPinnacle = Array.isArray(data)
        ? data.filter((g) => (g.bookmakers || []).some((b) => b.key === "pinnacle"))
        : data;

      return res.status(200).json({
        data: withPinnacle,
        meta: {
          source: "pinnacle",
          sport,
          region: "eu",
          markets,
          games: Array.isArray(withPinnacle) ? withPinnacle.length : null,
          quotaRemaining: quotaRemaining ? parseInt(quotaRemaining) : null,
          quotaUsed: quotaUsed ? parseInt(quotaUsed) : null,
          timestamp: new Date().toISOString(),
        },
      });
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
    bookmakers = "",
    oddsFormat = "american",
    dateFormat = "iso",
  } = req.query;

  try {
    const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds`);
    url.searchParams.set("apiKey", ODDS_API_KEY);
    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", markets);
    // Only filter by bookmakers if explicitly requested — otherwise get all US books
    if (bookmakers) url.searchParams.set("bookmakers", bookmakers);
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
