// api/soccer.js — Soccer stats proxy via ESPN public API (no key required)
// Covers: EPL, La Liga, Bundesliga, Serie A, Ligue 1, MLS, Champions League,
//         Europa League, World Cup, and more — all from one endpoint

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, player, team, league, date, limit = "10" } = req.query;

  // ── LEAGUE SLUG MAP ────────────────────────────────────────────────────────
  // Maps common names to ESPN league slugs
  const LEAGUE_SLUGS = {
    // English
    "epl": "eng.1", "premier league": "eng.1", "english premier": "eng.1",
    "championship": "eng.2", "league one": "eng.3",
    // Spanish
    "la liga": "esp.1", "laliga": "esp.1", "spain": "esp.1",
    "segunda": "esp.2",
    // German
    "bundesliga": "ger.1", "germany": "ger.1",
    "bundesliga 2": "ger.2",
    // Italian
    "serie a": "ita.1", "italy": "ita.1",
    "serie b": "ita.2",
    // French
    "ligue 1": "fra.1", "france": "fra.1",
    "ligue 2": "fra.2",
    // American
    "mls": "usa.1", "major league soccer": "usa.1",
    "usl": "usa.usl.l1",
    // European cups
    "champions league": "uefa.champions", "ucl": "uefa.champions",
    "europa league": "uefa.europa", "uel": "uefa.europa",
    "conference league": "uefa.europa.conf",
    // International
    "world cup": "fifa.world", "euros": "uefa.euro",
    "nations league": "uefa.nations",
    "copa america": "conmebol.america",
    // Other
    "eredivisie": "ned.1", "netherlands": "ned.1",
    "primeira liga": "por.1", "portugal": "por.1",
    "super lig": "tur.1", "turkey": "tur.1",
    "scottish premiership": "sco.1", "scotland": "sco.1",
    "belgian pro league": "bel.1", "belgium": "bel.1",
    "wbc": null, // not soccer
  };

  function resolveLeague(input) {
    if (!input) return "eng.1"; // default to EPL
    const key = input.toLowerCase().trim();
    return LEAGUE_SLUGS[key] || input; // pass through if already a slug
  }

  // ── LIST supported leagues — handle BEFORE slug resolution ─────────────────
  if (type === "leagues") {
    return res.status(200).json({
      type: "leagues",
      supported: Object.entries(LEAGUE_SLUGS)
        .filter(([, v]) => v)
        .map(([name, slug]) => ({ name, slug }))
    });
  }

  const leagueSlug = resolveLeague(league);
  const SITE = `https://site.api.espn.com/apis/site/v2/sports/soccer/${leagueSlug}`;
  const CORE = `https://sports.core.api.espn.com/v2/sports/soccer/leagues/${leagueSlug}`;

  try {

    // ── SCOREBOARD / fixtures ────────────────────────────────────────────────
    if (type === "scoreboard" || type === "schedule") {
      let url = `${SITE}/scoreboard`;
      if (date) {
        // date format: YYYYMMDD
        const d = date.replace(/-/g, "");
        url += `?dates=${d}`;
      }
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN soccer scoreboard returned ${r.status}`);
      const data = await r.json();

      return res.status(200).json({
        type: "scoreboard",
        league: leagueSlug,
        games: (data.events || []).map(e => {
          const comp = e.competitions?.[0];
          const home = comp?.competitors?.find(c => c.homeAway === "home");
          const away = comp?.competitors?.find(c => c.homeAway === "away");
          return {
            gameId: e.id,
            date: e.date,
            name: e.name,
            status: e.status?.type?.description,
            minute: e.status?.displayClock,
            home: {
              teamId: home?.team?.id,
              team: home?.team?.displayName,
              abbrev: home?.team?.abbreviation,
              score: home?.score,
              form: home?.form,
            },
            away: {
              teamId: away?.team?.id,
              team: away?.team?.displayName,
              abbrev: away?.team?.abbreviation,
              score: away?.score,
              form: away?.form,
            },
            venue: comp?.venue?.fullName,
            attendance: comp?.attendance,
            odds: comp?.odds?.[0] ? {
              details: comp.odds[0].details,
              overUnder: comp.odds[0].overUnder,
              homeOdds: comp.odds[0].homeTeamOdds?.moneyLine,
              awayOdds: comp.odds[0].awayTeamOdds?.moneyLine,
            } : null,
          };
        })
      });
    }

    // ── STANDINGS ────────────────────────────────────────────────────────────
    if (type === "standings") {
      const url = `${SITE}/standings`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN standings returned ${r.status}`);
      const data = await r.json();

      const table = [];
      for (const group of (data.standings?.entries || [])) {
        const stats = {};
        (group.stats || []).forEach(s => { stats[s.abbreviation || s.name] = s.displayValue; });
        table.push({
          rank: group.stats?.find(s => s.name === "rank")?.displayValue,
          team: group.team?.displayName,
          teamId: group.team?.id,
          abbrev: group.team?.abbreviation,
          gamesPlayed: stats.GP,
          wins: stats.W,
          draws: stats.D,
          losses: stats.L,
          goalsFor: stats.GF,
          goalsAgainst: stats.GA,
          goalDiff: stats.GD,
          points: stats.PTS,
          form: group.note?.description,
        });
      }

      return res.status(200).json({ type: "standings", league: leagueSlug, table });
    }

    // ── TEAM info + recent form ──────────────────────────────────────────────
    if (type === "team" && team) {
      const url = `${SITE}/teams/${team}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN team returned ${r.status}`);
      const data = await r.json();
      const t = data.team || {};

      // Also grab recent schedule for form
      const schedUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/${team}/schedule`;
      const sr = await fetch(schedUrl);
      const sched = await sr.json();
      const recent = (sched.events || [])
        .filter(e => e.status?.type?.completed)
        .slice(-5)
        .map(e => {
          const comp = e.competitions?.[0];
          const mine = comp?.competitors?.find(c => c.team?.id == team);
          const opp = comp?.competitors?.find(c => c.team?.id != team);
          return {
            date: e.date?.slice(0,10),
            opponent: opp?.team?.displayName,
            result: mine?.winner ? "W" : (opp?.winner ? "L" : "D"),
            score: `${mine?.score}-${opp?.score}`,
            homeAway: mine?.homeAway,
          };
        });

      return res.status(200).json({
        type: "team",
        teamId: team,
        name: t.displayName,
        abbreviation: t.abbreviation,
        league: leagueSlug,
        record: t.record?.items?.[0]?.summary,
        recentForm: recent,
        venue: t.venue?.fullName,
      });
    }

    // ── PLAYER search ────────────────────────────────────────────────────────
    if (type === "search" && player) {
      const url = `https://site.web.api.espn.com/apis/search/v2?limit=10&query=${encodeURIComponent(player)}&sport=soccer`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN search returned ${r.status}`);
      const data = await r.json();

      const players = [];
      for (const group of (data.results || [])) {
        for (const item of (group.contents || [])) {
          if (item.type === "athlete" || group.type === "athlete") {
            players.push({
              playerId: item.id,
              name: item.displayName,
              team: item.teamDisplayName,
              description: item.description,
            });
          }
        }
      }

      return res.status(200).json({
        type: "search",
        query: player,
        results: players.slice(0, 10)
      });
    }

    // ── PLAYER stats ─────────────────────────────────────────────────────────
    if (type === "stats" && player) {
      const url = `https://site.web.api.espn.com/apis/common/v3/sports/soccer/athletes/${player}/stats`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN player stats returned ${r.status}`);
      const data = await r.json();

      const stats = {};
      for (const cat of (data.splits?.categories || [])) {
        const vals = {};
        const names = cat.names || cat.labels || [];
        const values = cat.splits?.[0]?.stats || cat.totals || [];
        names.forEach((n, i) => { vals[n] = values[i]; });
        stats[cat.displayName || cat.name] = vals;
      }

      return res.status(200).json({
        type: "stats",
        playerId: player,
        name: data.athlete?.displayName,
        team: data.athlete?.team?.displayName,
        position: data.athlete?.position?.displayName,
        stats
      });
    }

    // ── TOP SCORERS / leaders ────────────────────────────────────────────────
    if (type === "leaders") {
      const url = `${SITE}/leaders`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN leaders returned ${r.status}`);
      const data = await r.json();

      const categories = {};
      for (const cat of (data.leaders || [])) {
        categories[cat.displayName || cat.name] = (cat.leaders || []).slice(0, 10).map(l => ({
          rank: l.rank,
          name: l.athlete?.displayName,
          team: l.team?.displayName,
          value: l.value,
          displayValue: l.displayValue,
        }));
      }

      return res.status(200).json({ type: "leaders", league: leagueSlug, categories });
    }

    // ── NEWS ─────────────────────────────────────────────────────────────────
    if (type === "news") {
      const url = `${SITE}/news?limit=5`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN news returned ${r.status}`);
      const data = await r.json();

      return res.status(200).json({
        type: "news",
        league: leagueSlug,
        articles: (data.articles || []).slice(0, 5).map(a => ({
          headline: a.headline,
          description: a.description,
          published: a.published,
        }))
      });
    }

    return res.status(400).json({
      error: "Invalid type",
      validTypes: ["leagues", "scoreboard", "standings", "team", "search", "stats", "leaders", "news"],
      examples: [
        "/api/soccer?type=leagues",
        "/api/soccer?type=scoreboard&league=epl",
        "/api/soccer?type=scoreboard&league=champions+league",
        "/api/soccer?type=scoreboard&league=mls&date=2025-04-15",
        "/api/soccer?type=standings&league=epl",
        "/api/soccer?type=standings&league=bundesliga",
        "/api/soccer?type=team&league=epl&team=363",
        "/api/soccer?type=search&player=Erling+Haaland",
        "/api/soccer?type=leaders&league=epl",
        "/api/soccer?type=news&league=champions+league",
      ]
    });

  } catch (err) {
    console.error("Soccer API error:", err);
    return res.status(500).json({ error: "Soccer API error", detail: err.message });
  }
}
