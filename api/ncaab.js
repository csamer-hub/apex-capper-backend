// api/ncaab.js — NCAA Men's Basketball via ESPN public API (no key required)
// Covers: scoreboard, standings, rankings, teams, player stats, search, news
// Also supports women's college basketball via gender=womens param

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, player, team, date, limit = "10", gender = "mens" } = req.query;

  const LEAGUE = `${gender}-college-basketball`;
  const SITE  = `https://site.api.espn.com/apis/site/v2/sports/basketball/${LEAGUE}`;
  const CORE  = `https://sports.core.api.espn.com/v2/sports/basketball/leagues/${LEAGUE}`;
  const SEARCH = "https://site.web.api.espn.com/apis/search/v2";

  try {

    // ── SCOREBOARD ───────────────────────────────────────────────────────────
    if (type === "scoreboard") {
      let url = `${SITE}/scoreboard`;
      if (date) url += `?dates=${date.replace(/-/g,"")}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN NCAAB scoreboard returned ${r.status}`);
      const data = await r.json();

      return res.status(200).json({
        type: "scoreboard",
        gender,
        games: (data.events || []).map(e => {
          const comp = e.competitions?.[0];
          const home = comp?.competitors?.find(c => c.homeAway === "home");
          const away = comp?.competitors?.find(c => c.homeAway === "away");
          return {
            gameId: e.id,
            date: e.date,
            name: e.name,
            status: e.status?.type?.description,
            home: {
              teamId: home?.team?.id,
              team: home?.team?.displayName,
              abbrev: home?.team?.abbreviation,
              score: home?.score,
              rank: home?.curatedRank?.current,
              record: home?.records?.[0]?.summary,
            },
            away: {
              teamId: away?.team?.id,
              team: away?.team?.displayName,
              abbrev: away?.team?.abbreviation,
              score: away?.score,
              rank: away?.curatedRank?.current,
              record: away?.records?.[0]?.summary,
            },
            venue: comp?.venue?.fullName,
            spread: comp?.odds?.[0]?.details,
            overUnder: comp?.odds?.[0]?.overUnder,
            broadcast: comp?.broadcasts?.[0]?.names?.[0],
          };
        })
      });
    }

    // ── RANKINGS (AP Top 25) ─────────────────────────────────────────────────
    if (type === "rankings") {
      const url = `${SITE}/rankings`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN NCAAB rankings returned ${r.status}`);
      const data = await r.json();

      const poll = data.rankings?.[0]; // AP Poll is usually first
      return res.status(200).json({
        type: "rankings",
        gender,
        pollName: poll?.name,
        lastUpdated: poll?.lastUpdated,
        rankings: (poll?.ranks || []).map(r => ({
          rank: r.current,
          previousRank: r.previous,
          teamId: r.team?.id,
          team: r.team?.displayName,
          abbrev: r.team?.abbreviation,
          conference: r.team?.conferenceId,
          record: `${r.recordSummary}`,
          points: r.points,
        }))
      });
    }

    // ── STANDINGS ────────────────────────────────────────────────────────────
    if (type === "standings") {
      const url = `${SITE}/standings`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN NCAAB standings returned ${r.status}`);
      const data = await r.json();

      const conferences = [];
      for (const group of (data.standings?.entries || data.children || [])) {
        const confName = group.name || group.abbreviation;
        const teams = [];
        for (const entry of (group.standings?.entries || group.entries || [])) {
          const stats = {};
          (entry.stats || []).forEach(s => { stats[s.abbreviation || s.name] = s.displayValue; });
          teams.push({
            teamId: entry.team?.id,
            team: entry.team?.displayName,
            abbrev: entry.team?.abbreviation,
            wins: stats.W || stats.wins,
            losses: stats.L || stats.losses,
            confWins: stats.CW,
            confLosses: stats.CL,
            pct: stats.PCT || stats.WP,
            streak: stats.streak,
          });
        }
        if (teams.length) conferences.push({ conference: confName, teams });
      }

      return res.status(200).json({ type: "standings", gender, conferences });
    }

    // ── TEAM info + schedule ─────────────────────────────────────────────────
    if (type === "team" && team) {
      const url = `${SITE}/teams/${team}?enable=roster,stats,schedule`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN team returned ${r.status}`);
      const data = await r.json();
      const t = data.team || {};

      return res.status(200).json({
        type: "team",
        teamId: team,
        name: t.displayName,
        abbreviation: t.abbreviation,
        conference: t.conferenceId,
        record: t.record?.items?.[0]?.summary,
        rank: t.rankSummary,
        venue: t.venue?.fullName,
        roster: (t.athletes || []).slice(0, 15).map(a => ({
          playerId: a.id,
          name: a.displayName,
          position: a.position?.abbreviation,
          jersey: a.jersey,
          year: a.experience?.displayValue,
        }))
      });
    }

    // ── TEAMS list ───────────────────────────────────────────────────────────
    if (type === "teams") {
      const url = `${SITE}/teams?limit=400`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN teams returned ${r.status}`);
      const data = await r.json();

      return res.status(200).json({
        type: "teams",
        gender,
        teams: (data.sports?.[0]?.leagues?.[0]?.teams || []).map(t => ({
          teamId: t.team.id,
          name: t.team.displayName,
          abbreviation: t.team.abbreviation,
          conference: t.team.conferenceId,
          location: t.team.location,
        }))
      });
    }

    // ── PLAYER SEARCH ────────────────────────────────────────────────────────
    if (type === "search" && player) {
      const url = `${SEARCH}?limit=10&query=${encodeURIComponent(player)}&sport=basketball&league=${LEAGUE}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN search returned ${r.status}`);
      const data = await r.json();

      const players = [];
      for (const group of (data.results || [])) {
        for (const item of (group.contents || [])) {
          if (group.type === "athlete" || item.type === "athlete") {
            players.push({
              playerId: item.id,
              name: item.displayName,
              team: item.teamDisplayName,
              description: item.description,
            });
          }
        }
      }

      return res.status(200).json({ type: "search", query: player, results: players.slice(0, 10) });
    }

    // ── PLAYER STATS ─────────────────────────────────────────────────────────
    if (type === "stats" && player) {
      const url = `https://site.web.api.espn.com/apis/common/v3/sports/basketball/${LEAGUE}/athletes/${player}/stats`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN player stats returned ${r.status}`);
      const data = await r.json();

      const stats = {};
      for (const cat of (data.splits?.categories || [])) {
        const vals = {};
        const names = cat.names || cat.labels || [];
        const values = cat.splits?.[0]?.stats || [];
        names.forEach((n, i) => { vals[n] = values[i]; });
        stats[cat.displayName || cat.name] = vals;
      }

      return res.status(200).json({
        type: "stats",
        playerId: player,
        name: data.athlete?.displayName,
        team: data.athlete?.team?.displayName,
        position: data.athlete?.position?.abbreviation,
        stats
      });
    }

    // ── STAT LEADERS ─────────────────────────────────────────────────────────
    if (type === "leaders") {
      const season = req.query.season || "2026";
      const url = `${CORE}/seasons/${season}/types/2/leaders?limit=10`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN leaders returned ${r.status}`);
      const data = await r.json();

      const categories = {};
      for (const cat of (data.categories || [])) {
        const leaders = [];
        for (const item of (cat.leaders || []).slice(0, parseInt(limit))) {
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
        categories[cat.displayName || cat.name] = leaders;
      }

      return res.status(200).json({ type: "leaders", gender, season, categories });
    }

    // ── GAME SUMMARY (box score) ─────────────────────────────────────────────
    if (type === "summary") {
      const gameId = req.query.game_id;
      if (!gameId) return res.status(400).json({ error: "game_id required" });
      const url = `https://site.web.api.espn.com/apis/site/v2/sports/basketball/${LEAGUE}/summary?event=${gameId}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN summary returned ${r.status}`);
      const data = await r.json();

      const boxscore = data.boxscore;
      const teams = (boxscore?.teams || []).map(t => ({
        team: t.team?.displayName,
        players: (t.statistics?.[0]?.athletes || []).slice(0, 10).map(a => ({
          name: a.athlete?.displayName,
          position: a.athlete?.position?.abbreviation,
          starter: a.starter,
          stats: a.stats,
        }))
      }));

      return res.status(200).json({
        type: "summary",
        gameId,
        header: data.header?.competitions?.[0],
        teams
      });
    }

    // ── NEWS ─────────────────────────────────────────────────────────────────
    if (type === "news") {
      const url = `${SITE}/news?limit=5`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN news returned ${r.status}`);
      const data = await r.json();

      return res.status(200).json({
        type: "news",
        gender,
        articles: (data.articles || []).slice(0, 5).map(a => ({
          headline: a.headline,
          description: a.description,
          published: a.published,
        }))
      });
    }

    return res.status(400).json({
      error: "Invalid type",
      validTypes: ["scoreboard", "rankings", "standings", "teams", "team", "search", "stats", "leaders", "summary", "news"],
      gender_note: "Add gender=womens for women's basketball",
      examples: [
        "/api/ncaab?type=scoreboard",
        "/api/ncaab?type=scoreboard&date=2025-03-15",
        "/api/ncaab?type=rankings",
        "/api/ncaab?type=standings",
        "/api/ncaab?type=teams",
        "/api/ncaab?type=search&player=Cooper+Flagg",
        "/api/ncaab?type=team&team=52",
        "/api/ncaab?type=leaders&season=2026",
        "/api/ncaab?type=news",
        "/api/ncaab?type=scoreboard&gender=womens",
      ]
    });

  } catch (err) {
    console.error("NCAAB API error:", err);
    return res.status(500).json({ error: "NCAAB API error", detail: err.message });
  }
}
