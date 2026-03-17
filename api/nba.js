// api/nba.js — NBA Stats proxy
// Uses stats.nba.com public endpoints (no key required, but needs headers)
// Also uses balldontlie.io free API as backup (no key for basic tier)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, player, team, season = "2024-25", limit = "10" } = req.query;

  // NBA.com requires browser-like headers to avoid 403
  const nbaHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Referer": "https://www.nba.com/",
    "Origin": "https://www.nba.com",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "x-nba-stats-origin": "stats",
    "x-nba-stats-token": "true",
  };

  try {

    if (type === "search" && player) {
      // Search players via BallDontLie free API
      const url = `https://www.balldontlie.io/api/v1/players?search=${encodeURIComponent(player)}&per_page=5`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json({
        type: "search",
        query: player,
        results: (data.data || []).map(p => ({
          playerId: p.id,
          name: `${p.first_name} ${p.last_name}`,
          team: p.team?.abbreviation,
          teamId: p.team?.id,
          position: p.position,
          heightFeet: p.height_feet,
          weightPounds: p.weight_pounds,
        }))
      });
    }

    if (type === "gamelog" && player) {
      // BallDontLie game stats
      const seasonYear = season.split("-")[0]; // "2024-25" -> "2024"
      const url = `https://www.balldontlie.io/api/v1/stats?player_ids[]=${player}&seasons[]=${seasonYear}&per_page=${limit}&sort_by=date&direction=desc`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json({
        type: "gamelog",
        playerId: player,
        season,
        games: (data.data || []).map(g => ({
          date: g.game?.date?.slice(0,10),
          opponent: g.game?.visitor_team_id === g.player?.team_id
            ? g.game?.home_team_score : g.game?.visitor_team_score,
          homeAway: g.game?.home_team_id === g.player?.team_id ? "H" : "A",
          points: g.pts,
          rebounds: g.reb,
          assists: g.ast,
          steals: g.stl,
          blocks: g.blk,
          turnovers: g.turnover,
          fgAttempted: g.fga,
          fgMade: g.fgm,
          fg3Attempted: g.fg3a,
          fg3Made: g.fg3m,
          ftAttempted: g.fta,
          ftMade: g.ftm,
          minutesPlayed: g.min,
          plusMinus: g.plus_minus,
        }))
      });
    }

    if (type === "stats" && player) {
      // Season averages from BallDontLie
      const seasonYear = season.split("-")[0];
      const url = `https://www.balldontlie.io/api/v1/season_averages?season=${seasonYear}&player_ids[]=${player}`;
      const r = await fetch(url);
      const data = await r.json();
      const avg = data.data?.[0];
      if (!avg) return res.status(200).json({ type: "stats", playerId: player, averages: null });

      return res.status(200).json({
        type: "stats",
        playerId: player,
        season,
        averages: {
          gamesPlayed: avg.games_played,
          pointsPerGame: avg.pts,
          reboundsPerGame: avg.reb,
          assistsPerGame: avg.ast,
          stealsPerGame: avg.stl,
          blocksPerGame: avg.blk,
          turnoversPerGame: avg.turnover,
          minutesPerGame: avg.min,
          fgPct: avg.fg_pct,
          fg3Pct: avg.fg3_pct,
          ftPct: avg.ft_pct,
          fg3Attempted: avg.fg3a,
          fg3Made: avg.fg3m,
        }
      });
    }

    if (type === "team" && team) {
      // Team info and players
      const url = `https://www.balldontlie.io/api/v1/teams?search=${encodeURIComponent(team)}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json({
        type: "team",
        results: data.data || []
      });
    }

    if (type === "matchup" && team) {
      // Recent games for a team — for pace/scoring context
      const url = `https://www.balldontlie.io/api/v1/games?team_ids[]=${team}&per_page=10&sort_by=date&direction=desc`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json({
        type: "matchup",
        teamId: team,
        recentGames: (data.data || []).map(g => ({
          date: g.date?.slice(0,10),
          homeTeam: g.home_team?.abbreviation,
          awayTeam: g.visitor_team?.abbreviation,
          homeScore: g.home_team_score,
          awayScore: g.visitor_team_score,
          status: g.status,
        }))
      });
    }

    return res.status(400).json({
      error: "Invalid type. Use: search, stats, gamelog, team, matchup",
      examples: [
        "/api/nba?type=search&player=LeBron+James",
        "/api/nba?type=stats&player=237&season=2024-25",
        "/api/nba?type=gamelog&player=237&limit=10",
        "/api/nba?type=team&team=Lakers",
        "/api/nba?type=matchup&team=14",
      ]
    });

  } catch (err) {
    console.error("NBA API error:", err);
    return res.status(500).json({ error: "NBA API error", detail: err.message });
  }
}
