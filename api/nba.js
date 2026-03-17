// api/nba.js — NBA Stats proxy
// Primary: api.server.nbaapi.com (no key, free, Basketball-Reference sourced)
// Fallback: stats.nba.com (no key, requires browser headers)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, player, team, season = "2025", limit = "10" } = req.query;

  // NBA.com headers (needed for direct stats.nba.com calls)
  const nbaHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Referer": "https://www.nba.com/",
    "Origin": "https://www.nba.com",
    "Accept": "application/json",
    "x-nba-stats-origin": "stats",
    "x-nba-stats-token": "true",
  };

  try {

    if (type === "search" && player) {
      // Search by name using nbaapi.com player totals endpoint
      const url = `https://api.server.nbaapi.com/api/playertotals?season=${season}&page=1&pageSize=500&sortBy=points&ascending=false`;
      const r = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!r.ok) throw new Error(`nbaapi returned ${r.status}`);
      const data = await r.json();

      // Filter by name client-side
      const q = player.toLowerCase();
      const matches = (data.data || []).filter(p =>
        q.split(" ").every(word => (p.playerName || "").toLowerCase().includes(word))
      ).slice(0, 10);

      return res.status(200).json({
        type: "search",
        query: player,
        season,
        results: matches.map(p => ({
          playerId: p.playerId,
          name: p.playerName,
          team: p.team,
          position: p.position,
          age: p.age,
          gamesPlayed: p.games,
          minutesPerGame: p.minutesPg,
          pointsPerGame: p.points,
          reboundsPerGame: p.totalRb,
          assistsPerGame: p.assists,
          stealsPerGame: p.steals,
          blocksPerGame: p.blocks,
          turnoversPerGame: p.turnovers,
          fg3PerGame: p.threeFg,
          fg3Attempts: p.threeAttempts,
          fg3Pct: p.threePercent,
          fgPct: p.fieldPercent,
          ftPct: p.ftPercent,
        }))
      });
    }

    if (type === "stats" && player) {
      // Get season averages for a specific player ID
      const url = `https://api.server.nbaapi.com/api/playertotals?playerId=${encodeURIComponent(player)}&season=${season}`;
      const r = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!r.ok) throw new Error(`nbaapi stats returned ${r.status}`);
      const data = await r.json();
      const p = data.data?.[0];
      if (!p) return res.status(200).json({ type: "stats", playerId: player, data: null });

      return res.status(200).json({
        type: "stats",
        playerId: player,
        name: p.playerName,
        team: p.team,
        position: p.position,
        season,
        averages: {
          gamesPlayed: p.games,
          minutesPerGame: p.minutesPg,
          pointsPerGame: p.points,
          reboundsPerGame: p.totalRb,
          offRebPerGame: p.offensiveRb,
          defRebPerGame: p.defensiveRb,
          assistsPerGame: p.assists,
          stealsPerGame: p.steals,
          blocksPerGame: p.blocks,
          turnoversPerGame: p.turnovers,
          fg3PerGame: p.threeFg,
          fg3Attempts: p.threeAttempts,
          fg3Pct: p.threePercent,
          fgPct: p.fieldPercent,
          ftPct: p.ftPercent,
          ftAttempts: p.ftAttempts,
        }
      });
    }

    if (type === "advanced" && player) {
      // Advanced stats: PER, TS%, Usage%, Win Shares, VORP
      const url = `https://api.server.nbaapi.com/api/playeradvancedstats?playerId=${encodeURIComponent(player)}&season=${season}`;
      const r = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!r.ok) throw new Error(`nbaapi advanced returned ${r.status}`);
      const data = await r.json();
      const p = data.data?.[0];
      if (!p) return res.status(200).json({ type: "advanced", playerId: player, data: null });

      return res.status(200).json({
        type: "advanced",
        playerId: player,
        name: p.playerName,
        team: p.team,
        season,
        advanced: {
          per: p.per,
          tsPercent: p.tsPercent,
          usagePercent: p.usagePercent,
          assistPercent: p.assistPercent,
          reboundPercent: p.totalRBPercent,
          blockPercent: p.blockPercent,
          stealPercent: p.stealPercent,
          winShares: p.winShares,
          winSharesPer48: p.winSharesPer,
          vorp: p.vorp,
          offensiveBox: p.offensiveBox,
          defensiveBox: p.defensiveBox,
          box: p.box,
          minutesPlayed: p.minutesPlayed,
        }
      });
    }

    if (type === "leaders") {
      // Top scorers / stat leaders for the season
      const stat = req.query.stat || "points";
      const url = `https://api.server.nbaapi.com/api/playertotals?season=${season}&page=1&pageSize=25&sortBy=${stat}&ascending=false`;
      const r = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!r.ok) throw new Error(`nbaapi leaders returned ${r.status}`);
      const data = await r.json();

      return res.status(200).json({
        type: "leaders",
        season,
        sortedBy: stat,
        players: (data.data || []).map(p => ({
          playerId: p.playerId,
          name: p.playerName,
          team: p.team,
          position: p.position,
          gamesPlayed: p.games,
          pointsPerGame: p.points,
          reboundsPerGame: p.totalRb,
          assistsPerGame: p.assists,
          minutesPerGame: p.minutesPg,
          fg3PerGame: p.threeFg,
        }))
      });
    }

    if (type === "team" && team) {
      // Get all players for a team
      const url = `https://api.server.nbaapi.com/api/playertotals?team=${encodeURIComponent(team.toUpperCase())}&season=${season}&page=1&pageSize=20&sortBy=minutesPg&ascending=false`;
      const r = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!r.ok) throw new Error(`nbaapi team returned ${r.status}`);
      const data = await r.json();

      return res.status(200).json({
        type: "team",
        team: team.toUpperCase(),
        season,
        players: (data.data || []).map(p => ({
          playerId: p.playerId,
          name: p.playerName,
          position: p.position,
          gamesPlayed: p.games,
          minutesPerGame: p.minutesPg,
          pointsPerGame: p.points,
          reboundsPerGame: p.totalRb,
          assistsPerGame: p.assists,
          fg3PerGame: p.threeFg,
          usageApprox: p.minutesPg > 0 ? ((p.points + p.assists * 1.5 + p.totalRb) / p.minutesPg).toFixed(2) : "0.00",
        }))
      });
    }

    // Game log via NBA.com stats API directly
    if (type === "gamelog" && player) {
      // NBA.com player ID format (numeric, e.g. 2544 for LeBron)
      const seasonStr = `${parseInt(season)-1}-${season.slice(2)}`;
      const url = `https://stats.nba.com/stats/playergamelog?PlayerID=${player}&Season=${seasonStr}&SeasonType=Regular+Season`;
      const r = await fetch(url, { headers: nbaHeaders });
      if (!r.ok) throw new Error(`NBA.com gamelog returned ${r.status}`);
      const data = await r.json();
      const headers = data.resultSets?.[0]?.headers || [];
      const rows = (data.resultSets?.[0]?.rowSet || []).slice(0, parseInt(limit));

      const idx = (name) => headers.indexOf(name);
      return res.status(200).json({
        type: "gamelog",
        playerId: player,
        season: seasonStr,
        games: rows.map(row => ({
          date: row[idx("GAME_DATE")],
          matchup: row[idx("MATCHUP")],
          result: row[idx("WL")],
          minutes: row[idx("MIN")],
          points: row[idx("PTS")],
          rebounds: row[idx("REB")],
          assists: row[idx("AST")],
          steals: row[idx("STL")],
          blocks: row[idx("BLK")],
          turnovers: row[idx("TOV")],
          fg3Made: row[idx("FG3M")],
          fg3Attempted: row[idx("FG3A")],
          fgPct: row[idx("FG_PCT")],
          plusMinus: row[idx("PLUS_MINUS")],
        }))
      });
    }

    return res.status(400).json({
      error: "Invalid type",
      validTypes: ["search", "stats", "advanced", "gamelog", "leaders", "team"],
      examples: [
        "/api/nba?type=search&player=LeBron+James",
        "/api/nba?type=search&player=Nikola+Jokic&season=2025",
        "/api/nba?type=stats&player=jokicni01&season=2025",
        "/api/nba?type=advanced&player=jokicni01&season=2025",
        "/api/nba?type=leaders&season=2025&stat=points",
        "/api/nba?type=team&team=DEN&season=2025",
        "/api/nba?type=gamelog&player=203999&limit=10",
      ]
    });

  } catch (err) {
    console.error("NBA API error:", err);
    return res.status(500).json({ error: "NBA API error", detail: err.message });
  }
}
