// api/nfl.js — NFL Stats proxy via ESPN public API (no key required)
// Covers: player search, stats, team rosters, injuries, schedule, scoreboard, leaders

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, player, team, season = "2025", week, limit = "10" } = req.query;

  const SITE    = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
  const CORE    = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
  const SEARCH  = "https://site.web.api.espn.com/apis/search/v2";

  try {

    // ── SEARCH player by name ────────────────────────────────────────────────
    if (type === "search" && player) {
      const url = `${SEARCH}?limit=10&query=${encodeURIComponent(player)}&sport=football&league=nfl`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN search returned ${r.status}`);
      const data = await r.json();

      // Results live in multiple result groups
      const athletes = [];
      for (const group of (data.results || [])) {
        if (group.type === "athlete" || group.displayName?.toLowerCase().includes("player")) {
          for (const item of (group.contents || [])) {
            athletes.push({
              playerId: item.id,
              name: item.displayName || item.description,
              team: item.teamDisplayName || item.team,
              position: item.position,
              description: item.description,
            });
          }
        }
      }

      return res.status(200).json({
        type: "search",
        query: player,
        results: athletes.slice(0, 10)
      });
    }

    // ── PLAYER stats ─────────────────────────────────────────────────────────
    if (type === "stats" && player) {
      const url = `${SITE}/athletes/${player}/statistics`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN player stats returned ${r.status}`);
      const data = await r.json();

      // ESPN stats come in categories with labels
      const parsed = {};
      for (const cat of (data.splits?.categories || [])) {
        const catName = cat.displayName || cat.name || "general";
        const vals = {};
        const names = cat.names || [];
        const values = cat.splits?.[0]?.stats || [];
        names.forEach((n, i) => { vals[n] = values[i]; });
        parsed[catName] = vals;
      }

      return res.status(200).json({
        type: "stats",
        playerId: player,
        name: data.athlete?.displayName,
        team: data.athlete?.team?.displayName,
        position: data.athlete?.position?.abbreviation,
        season,
        stats: parsed
      });
    }

    // ── TEAM roster + stats ──────────────────────────────────────────────────
    if (type === "team" && team) {
      const url = `${SITE}/teams/${team}?enable=roster,stats`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN team returned ${r.status}`);
      const data = await r.json();
      const t = data.team || {};

      return res.status(200).json({
        type: "team",
        teamId: team,
        name: t.displayName,
        abbreviation: t.abbreviation,
        record: t.record?.items?.[0]?.summary,
        roster: (t.athletes || []).map(a => ({
          playerId: a.id,
          name: a.displayName,
          position: a.position?.abbreviation,
          jersey: a.jersey,
          status: a.status?.type,
        }))
      });
    }

    // ── INJURIES for a team ──────────────────────────────────────────────────
    if (type === "injuries" && team) {
      const url = `${CORE}/teams/${team}/injuries`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN injuries returned ${r.status}`);
      const data = await r.json();

      // Fetch each injury item
      const injuries = [];
      for (const item of (data.items || []).slice(0, 20)) {
        try {
          const ir = await fetch(item.$ref);
          const id = await ir.json();
          injuries.push({
            player: id.athlete?.displayName,
            status: id.status,
            type: id.type?.description || id.type,
            detail: id.shortComment || id.longComment,
            date: id.date,
          });
        } catch {}
      }

      return res.status(200).json({ type: "injuries", teamId: team, injuries });
    }

    // ── SCHEDULE / scoreboard ────────────────────────────────────────────────
    if (type === "schedule") {
      let url = `${SITE}/scoreboard`;
      if (week) url += `?seasontype=2&week=${week}&dates=${season}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN scoreboard returned ${r.status}`);
      const data = await r.json();

      return res.status(200).json({
        type: "schedule",
        week: data.week?.number,
        season: data.season?.year,
        games: (data.events || []).map(e => {
          const comp = e.competitions?.[0];
          const home = comp?.competitors?.find(c => c.homeAway === "home");
          const away = comp?.competitors?.find(c => c.homeAway === "away");
          return {
            gameId: e.id,
            date: e.date,
            status: e.status?.type?.description,
            home: { team: home?.team?.displayName, abbrev: home?.team?.abbreviation, score: home?.score, record: home?.records?.[0]?.summary },
            away: { team: away?.team?.displayName, abbrev: away?.team?.abbreviation, score: away?.score, record: away?.records?.[0]?.summary },
            venue: comp?.venue?.fullName,
            spread: comp?.odds?.[0]?.details,
            overUnder: comp?.odds?.[0]?.overUnder,
          };
        })
      });
    }

    // ── TEAM list (get IDs) ──────────────────────────────────────────────────
    if (type === "teams") {
      const url = `${SITE}/teams`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN teams returned ${r.status}`);
      const data = await r.json();

      return res.status(200).json({
        type: "teams",
        teams: (data.sports?.[0]?.leagues?.[0]?.teams || []).map(t => ({
          teamId: t.team.id,
          name: t.team.displayName,
          abbreviation: t.team.abbreviation,
          location: t.team.location,
          conference: t.team.conferenceId,
        }))
      });
    }

    // ── PASSING / RUSHING / RECEIVING LEADERS ────────────────────────────────
    if (type === "leaders") {
      const cat = req.query.stat || "passingYards"; // passingYards, rushingYards, receivingYards, sacks, interceptions
      const url = `${CORE}/seasons/${season}/types/2/leaders?limit=20`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN leaders returned ${r.status}`);
      const data = await r.json();

      // Find the right category
      const catData = (data.categories || []).find(c =>
        c.name?.toLowerCase().includes(cat.toLowerCase()) ||
        c.displayName?.toLowerCase().includes(cat.toLowerCase())
      ) || data.categories?.[0];

      const leaders = [];
      for (const item of (catData?.leaders || []).slice(0, parseInt(limit))) {
        try {
          const ar = await fetch(item.athlete.$ref);
          const athlete = await ar.json();
          leaders.push({
            rank: item.rank,
            name: athlete.displayName,
            team: athlete.team?.displayName,
            value: item.value,
            displayValue: item.displayValue,
          });
        } catch {
          leaders.push({ rank: item.rank, value: item.value, displayValue: item.displayValue });
        }
      }

      return res.status(200).json({ type: "leaders", stat: cat, season, leaders });
    }

    // ── DEPTH CHART for a team ───────────────────────────────────────────────
    if (type === "depthchart" && team) {
      const url = `${CORE}/seasons/${season}/teams/${team}/depthcharts`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN depthchart returned ${r.status}`);
      const data = await r.json();

      const positions = [];
      for (const pos of (data.items || []).slice(0, 15)) {
        const athletes = [];
        for (const slot of (pos.athletes || [])) {
          try {
            const ar = await fetch(slot.athlete.$ref);
            const a = await ar.json();
            athletes.push({ rank: slot.rank, name: a.displayName, playerId: a.id });
          } catch {}
        }
        positions.push({ position: pos.position?.displayName || pos.position?.abbreviation, athletes });
      }

      return res.status(200).json({ type: "depthchart", teamId: team, season, positions });
    }

    // ── NEWS for a team ──────────────────────────────────────────────────────
    if (type === "news" && team) {
      const url = `${SITE}/news?team=${team}&limit=5`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN news returned ${r.status}`);
      const data = await r.json();

      return res.status(200).json({
        type: "news",
        teamId: team,
        articles: (data.articles || []).slice(0, 5).map(a => ({
          headline: a.headline,
          description: a.description,
          published: a.published,
          byline: a.byline,
        }))
      });
    }

    return res.status(400).json({
      error: "Invalid type",
      validTypes: ["search", "stats", "team", "teams", "injuries", "schedule", "leaders", "depthchart", "news"],
      examples: [
        "/api/nfl?type=search&player=Patrick+Mahomes",
        "/api/nfl?type=stats&player=3139477",
        "/api/nfl?type=team&team=12",
        "/api/nfl?type=teams",
        "/api/nfl?type=injuries&team=12",
        "/api/nfl?type=schedule",
        "/api/nfl?type=schedule&week=1&season=2025",
        "/api/nfl?type=leaders&stat=passingYards&season=2025",
        "/api/nfl?type=depthchart&team=12&season=2025",
        "/api/nfl?type=news&team=12",
      ]
    });

  } catch (err) {
    console.error("NFL API error:", err);
    return res.status(500).json({ error: "NFL API error", detail: err.message });
  }
}
