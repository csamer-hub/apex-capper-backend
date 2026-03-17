// api/nhl.js — NHL Stats proxy using confirmed working endpoints
// Sources: api-web.nhle.com (v1) and api.nhle.com/stats/rest

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, player, team, season = "20242025", limit = "10" } = req.query;

  try {

    if (type === "search" && player) {
      // Search skaters by name using stats REST API
      const name = encodeURIComponent(player);
      const url = `https://api.nhle.com/stats/rest/en/skater/summary?isAggregate=false&isGame=false&sort=[{"property":"points","direction":"DESC"}]&start=0&limit=20&factCayenneExp=gamesPlayed>=1&cayenneExp=seasonId=20242025 and gameTypeId=2&name=${name}`;
      
      // Alternative: use the skater summary with a broad filter then filter by name client-side
      const url2 = `https://api.nhle.com/stats/rest/en/skater/summary?isAggregate=false&isGame=false&sort=%5B%7B%22property%22%3A%22points%22%2C%22direction%22%3A%22DESC%22%7D%5D&start=0&limit=500&factCayenneExp=gamesPlayed%3E=1&cayenneExp=seasonId=20242025%20and%20gameTypeId=2`;
      
      const r = await fetch(url2, {
        headers: { "Accept": "application/json" }
      });
      
      if (!r.ok) throw new Error(`NHL API returned ${r.status}`);
      const data = await r.json();
      
      // Filter by name client-side
      const query = player.toLowerCase();
      const matches = (data.data || []).filter(p => {
        const full = `${p.skaterFullName || ""}`.toLowerCase();
        return query.split(" ").every(word => full.includes(word));
      }).slice(0, 10);

      return res.status(200).json({
        type: "search",
        query: player,
        results: matches.map(p => ({
          playerId: p.playerId,
          name: p.skaterFullName,
          team: p.teamAbbrevs,
          position: p.positionCode,
          gamesPlayed: p.gamesPlayed,
          goals: p.goals,
          assists: p.assists,
          points: p.points,
          pointsPerGame: p.gamesPlayed > 0 ? (p.points / p.gamesPlayed).toFixed(2) : "0.00",
          shots: p.shots,
          timeOnIcePerGame: p.timeOnIcePerGame,
          powerPlayPoints: p.ppPoints,
          plusMinus: p.plusMinus,
        }))
      });
    }

    if (type === "gamelog" && player) {
      // Game log via api-web.nhle.com
      const url = `https://api-web.nhle.com/v1/player/${player}/game-log/${season}/2`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`NHL gamelog returned ${r.status}`);
      const data = await r.json();
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
          toi: g.toi,
          powerPlayGoals: g.powerPlayGoals,
          powerPlayPoints: g.powerPlayPoints,
          plusMinus: g.plusMinus,
        }))
      });
    }

    if (type === "stats" && player) {
      // Player landing page — current season stats
      const url = `https://api-web.nhle.com/v1/player/${player}/landing`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`NHL stats returned ${r.status}`);
      const data = await r.json();
      const cur = data.featuredStats?.regularSeason?.subSeason;
      return res.status(200).json({
        type: "stats",
        playerId: player,
        name: `${data.firstName?.default || ""} ${data.lastName?.default || ""}`.trim(),
        team: data.currentTeamAbbrev,
        position: data.position,
        currentSeason: cur ? {
          season: data.featuredStats?.season,
          gamesPlayed: cur.gamesPlayed,
          goals: cur.goals,
          assists: cur.assists,
          points: cur.points,
          pointsPerGame: cur.gamesPlayed > 0 ? (cur.points / cur.gamesPlayed).toFixed(2) : "0.00",
          goalsPerGame: cur.gamesPlayed > 0 ? (cur.goals / cur.gamesPlayed).toFixed(2) : "0.00",
          shotsPerGame: cur.shots && cur.gamesPlayed > 0 ? (cur.shots / cur.gamesPlayed).toFixed(1) : null,
          powerPlayPoints: cur.powerPlayPoints,
          plusMinus: cur.plusMinus,
        } : null
      });
    }

    if (type === "team" && team) {
      const url = `https://api-web.nhle.com/v1/roster/${team.toUpperCase()}/current`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`NHL roster returned ${r.status}`);
      const data = await r.json();
      const all = [...(data.forwards||[]), ...(data.defensemen||[]), ...(data.goalies||[])];
      return res.status(200).json({
        type: "team",
        team: team.toUpperCase(),
        roster: all.map(p => ({
          playerId: p.id,
          name: `${p.firstName?.default||""} ${p.lastName?.default||""}`.trim(),
          number: p.sweaterNumber,
          position: p.positionCode,
        }))
      });
    }

    if (type === "goalie" && team) {
      const url = `https://api-web.nhle.com/v1/club-stats/${team.toUpperCase()}/now`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`NHL club-stats returned ${r.status}`);
      const data = await r.json();
      return res.status(200).json({
        type: "goalie",
        team: team.toUpperCase(),
        goalies: (data.goalies||[]).map(g => ({
          playerId: g.playerId,
          name: `${g.firstName?.default||""} ${g.lastName?.default||""}`.trim(),
          gamesPlayed: g.gamesPlayed,
          wins: g.wins,
          savePercentage: g.savePercentage,
          goalsAgainstAverage: g.goalsAgainstAverage,
          shutouts: g.shutouts,
        }))
      });
    }

    if (type === "schedule" && team) {
      const url = `https://api-web.nhle.com/v1/club-schedule/${team.toUpperCase()}/week/now`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`NHL schedule returned ${r.status}`);
      const data = await r.json();
      return res.status(200).json({
        type: "schedule",
        team: team.toUpperCase(),
        games: (data.games||[]).map(g => ({
          gameId: g.id,
          date: g.gameDate,
          home: g.homeTeam?.abbrev,
          away: g.awayTeam?.abbrev,
          status: g.gameState,
        }))
      });
    }

    // Skater season stats with sorting — useful for top scorers
    if (type === "leaders") {
      const url = `https://api.nhle.com/stats/rest/en/skater/summary?isAggregate=false&isGame=false&sort=%5B%7B%22property%22%3A%22points%22%2C%22direction%22%3A%22DESC%22%7D%5D&start=0&limit=25&factCayenneExp=gamesPlayed%3E=1&cayenneExp=seasonId=20242025%20and%20gameTypeId=2`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json({
        type: "leaders",
        skaters: (data.data||[]).map(p => ({
          playerId: p.playerId,
          name: p.skaterFullName,
          team: p.teamAbbrevs,
          position: p.positionCode,
          gamesPlayed: p.gamesPlayed,
          goals: p.goals,
          assists: p.assists,
          points: p.points,
          pointsPerGame: p.gamesPlayed > 0 ? (p.points / p.gamesPlayed).toFixed(2) : "0.00",
        }))
      });
    }

    return res.status(400).json({
      error: "Invalid type",
      validTypes: ["search", "stats", "gamelog", "team", "goalie", "schedule", "leaders"],
      examples: [
        "/api/nhl?type=search&player=Nathan+MacKinnon",
        "/api/nhl?type=stats&player=8478402",
        "/api/nhl?type=gamelog&player=8478402&limit=10",
        "/api/nhl?type=team&team=COL",
        "/api/nhl?type=goalie&team=COL",
        "/api/nhl?type=leaders",
      ]
    });

  } catch (err) {
    console.error("NHL API error:", err);
    return res.status(500).json({ error: "NHL API error", detail: err.message });
  }
}
