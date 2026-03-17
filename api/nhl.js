// api/nhl.js — NHL Stats proxy via the public NHL API (no key required)
// Endpoints: api-web.nhle.com (current) and api.nhle.com (legacy)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, player, team, season = "20242025", limit = "10" } = req.query;

  try {
    let url, data;

    if (type === "search" && player) {
      // Search for a player by name
      url = `https://search.d3.nhle.com/api/v1/search?q=${encodeURIComponent(player)}&type=player&limit=5`;
      const r = await fetch(url);
      data = await r.json();
      return res.status(200).json({
        type: "search",
        query: player,
        results: (data || []).map(p => ({
          playerId: p.playerId,
          name: `${p.firstName?.default} ${p.lastName?.default}`,
          team: p.teamAbbrev,
          position: p.positionCode,
          sweaterNumber: p.sweaterNumber,
        }))
      });
    }

    if (type === "gamelog" && player) {
      // Get recent game log for a player by ID
      url = `https://api-web.nhle.com/v1/player/${player}/game-log/${season}/2`; // 2 = regular season
      const r = await fetch(url);
      data = await r.json();
      const games = (data.gameLog || []).slice(0, parseInt(limit));
      return res.status(200).json({
        type: "gamelog",
        playerId: player,
        season,
        games: games.map(g => ({
          date: g.gameDate,
          opponent: g.opponentAbbrev,
          homeAway: g.homeRoadFlag,
          goals: g.goals,
          assists: g.assists,
          points: g.points,
          shots: g.shots,
          toi: g.toi, // time on ice mm:ss
          powerPlayGoals: g.powerPlayGoals,
          powerPlayPoints: g.powerPlayPoints,
          plusMinus: g.plusMinus,
        }))
      });
    }

    if (type === "stats" && player) {
      // Get current season stats for a player
      url = `https://api-web.nhle.com/v1/player/${player}/landing`;
      const r = await fetch(url);
      data = await r.json();
      const currentStats = data.featuredStats?.regularSeason?.subSeason;
      const careerStats = data.featuredStats?.regularSeason?.career;
      return res.status(200).json({
        type: "stats",
        playerId: player,
        name: `${data.firstName?.default} ${data.lastName?.default}`,
        team: data.currentTeamAbbrev,
        position: data.position,
        currentSeason: currentStats ? {
          season: data.featuredStats?.season,
          gamesPlayed: currentStats.gamesPlayed,
          goals: currentStats.goals,
          assists: currentStats.assists,
          points: currentStats.points,
          pointsPerGame: currentStats.gamesPlayed > 0
            ? (currentStats.points / currentStats.gamesPlayed).toFixed(2)
            : "0.00",
          goalsPerGame: currentStats.gamesPlayed > 0
            ? (currentStats.goals / currentStats.gamesPlayed).toFixed(2)
            : "0.00",
          shotsPerGame: currentStats.gamesPlayed > 0 && currentStats.shots
            ? (currentStats.shots / currentStats.gamesPlayed).toFixed(1)
            : null,
          powerPlayPoints: currentStats.powerPlayPoints,
          plusMinus: currentStats.plusMinus,
        } : null,
        careerStats: careerStats ? {
          gamesPlayed: careerStats.gamesPlayed,
          points: careerStats.points,
          pointsPerGame: careerStats.gamesPlayed > 0
            ? (careerStats.points / careerStats.gamesPlayed).toFixed(2)
            : "0.00",
        } : null,
      });
    }

    if (type === "team" && team) {
      // Get team roster and stats
      url = `https://api-web.nhle.com/v1/roster/${team}/current`;
      const r = await fetch(url);
      data = await r.json();
      const allPlayers = [
        ...(data.forwards || []),
        ...(data.defensemen || []),
        ...(data.goalies || []),
      ];
      return res.status(200).json({
        type: "team",
        team,
        roster: allPlayers.map(p => ({
          playerId: p.id,
          name: `${p.firstName?.default} ${p.lastName?.default}`,
          number: p.sweaterNumber,
          position: p.positionCode,
        }))
      });
    }

    if (type === "schedule" && team) {
      // Get upcoming schedule for a team
      url = `https://api-web.nhle.com/v1/club-schedule/${team}/week/now`;
      const r = await fetch(url);
      data = await r.json();
      return res.status(200).json({
        type: "schedule",
        team,
        games: (data.games || []).map(g => ({
          gameId: g.id,
          date: g.gameDate,
          home: g.homeTeam?.abbrev,
          away: g.awayTeam?.abbrev,
          venue: g.venue?.default,
          status: g.gameState,
        }))
      });
    }

    if (type === "goalie" && team) {
      // Get goalie stats for a team — useful for matchup context
      url = `https://api-web.nhle.com/v1/club-stats/${team}/now`;
      const r = await fetch(url);
      data = await r.json();
      const goalies = (data.goalies || []).map(g => ({
        playerId: g.playerId,
        name: `${g.firstName?.default} ${g.lastName?.default}`,
        gamesPlayed: g.gamesPlayed,
        wins: g.wins,
        losses: g.losses,
        savePercentage: g.savePercentage,
        goalsAgainstAverage: g.goalsAgainstAverage,
        shutouts: g.shutouts,
      }));
      return res.status(200).json({ type: "goalie", team, goalies });
    }

    if (type === "teamstats" && team) {
      // Get team-level stats for matchup context
      url = `https://api-web.nhle.com/v1/club-stats/${team}/now`;
      const r = await fetch(url);
      data = await r.json();
      return res.status(200).json({
        type: "teamstats",
        team,
        skaters: (data.skaters || []).slice(0, 20).map(s => ({
          playerId: s.playerId,
          name: `${s.firstName?.default} ${s.lastName?.default}`,
          position: s.positionCode,
          gamesPlayed: s.gamesPlayed,
          goals: s.goals,
          assists: s.assists,
          points: s.points,
          pointsPerGame: s.gamesPlayed > 0 ? (s.points / s.gamesPlayed).toFixed(2) : "0.00",
          shots: s.shots,
          toi: s.avgToi,
        }))
      });
    }

    return res.status(400).json({
      error: "Invalid type. Use: search, stats, gamelog, team, teamstats, goalie, schedule",
      examples: [
        "/api/nhl?type=search&player=Nathan+MacKinnon",
        "/api/nhl?type=stats&player=8478402",
        "/api/nhl?type=gamelog&player=8478402&limit=10",
        "/api/nhl?type=team&team=COL",
        "/api/nhl?type=goalie&team=COL",
        "/api/nhl?type=schedule&team=COL",
      ]
    });

  } catch (err) {
    console.error("NHL API error:", err);
    return res.status(500).json({ error: "NHL API error", detail: err.message });
  }
}
