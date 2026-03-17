// api/mlb.js — MLB Stats proxy via statsapi.mlb.com (no key required)
// Covers: player search, hitting/pitching stats, game logs, team rosters,
//         schedule with probable pitchers, stat leaders, umpire assignments

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const {
    type, player, team, season = "2025",
    limit = "10", group = "hitting"
  } = req.query;

  const BASE = "https://statsapi.mlb.com/api/v1";

  try {

    // ── SEARCH player by name ────────────────────────────────────────────────
    if (type === "search" && player) {
      const url = `${BASE}/sports/1/players?season=${season}&gameType=R`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`MLB players returned ${r.status}`);
      const data = await r.json();

      const q = player.toLowerCase();
      const matches = (data.people || [])
        .filter(p => q.split(" ").every(w => (p.fullName || "").toLowerCase().includes(w)))
        .slice(0, 10);

      return res.status(200).json({
        type: "search",
        query: player,
        results: matches.map(p => ({
          playerId: p.id,
          name: p.fullName,
          team: p.currentTeam?.name,
          teamId: p.currentTeam?.id,
          position: p.primaryPosition?.abbreviation,
          batSide: p.batSide?.code,
          pitchHand: p.pitchHand?.code,
          age: p.currentAge,
        }))
      });
    }

    // ── PLAYER season stats (hitting or pitching) ────────────────────────────
    if (type === "stats" && player) {
      const url = `${BASE}/people/${player}/stats?stats=season&season=${season}&group=${group}&sportId=1`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`MLB stats returned ${r.status}`);
      const data = await r.json();
      const splits = data.stats?.[0]?.splits || [];
      const s = splits[0]?.stat || {};
      const gp = parseInt(s.gamesPlayed || s.gamesPitched || 0);

      // Profile
      const profileUrl = `${BASE}/people/${player}`;
      const pr = await fetch(profileUrl);
      const profile = await pr.json();
      const p = profile.people?.[0] || {};

      if (group === "hitting") {
        return res.status(200).json({
          type: "stats",
          group: "hitting",
          playerId: player,
          name: p.fullName,
          team: p.currentTeam?.name,
          position: p.primaryPosition?.abbreviation,
          season,
          stats: {
            gamesPlayed: gp,
            atBats: s.atBats,
            hits: s.hits,
            hitsPerGame: gp > 0 ? (parseInt(s.hits||0) / gp).toFixed(2) : "0.00",
            doubles: s.doubles,
            triples: s.triples,
            homeRuns: s.homeRuns,
            homeRunsPerGame: gp > 0 ? (parseInt(s.homeRuns||0) / gp).toFixed(3) : "0.000",
            rbi: s.rbi,
            runs: s.runs,
            stolenBases: s.stolenBases,
            walks: s.baseOnBalls,
            strikeouts: s.strikeOuts,
            avg: s.avg,
            obp: s.obp,
            slg: s.slg,
            ops: s.ops,
            totalBases: s.totalBases,
            totalBasesPerGame: gp > 0 ? (parseInt(s.totalBases||0) / gp).toFixed(2) : "0.00",
            babip: s.babip,
            plateAppearances: s.plateAppearances,
          }
        });
      } else {
        // Pitching
        const ip = parseFloat(s.inningsPitched || 0);
        return res.status(200).json({
          type: "stats",
          group: "pitching",
          playerId: player,
          name: p.fullName,
          team: p.currentTeam?.name,
          season,
          stats: {
            gamesPitched: s.gamesPitched,
            gamesStarted: s.gamesStarted,
            wins: s.wins,
            losses: s.losses,
            era: s.era,
            inningsPitched: s.inningsPitched,
            hits: s.hits,
            runs: s.runs,
            earnedRuns: s.earnedRuns,
            homeRuns: s.homeRuns,
            walks: s.baseOnBalls,
            strikeouts: s.strikeOuts,
            whip: s.whip,
            strikeoutsPer9: s.strikeoutsPer9Inn,
            walksPer9: s.walksPer9Inn,
            hitsPer9: s.hitsPer9Inn,
            k_bb_ratio: s.strikeoutWalkRatio,
            saves: s.saves,
            blownSaves: s.blownSaves,
            holds: s.holds,
            battersFaced: s.battersFaced,
            pitchesPerInning: s.pitchesPerInning,
          }
        });
      }
    }

    // ── GAME LOG ─────────────────────────────────────────────────────────────
    if (type === "gamelog" && player) {
      const url = `${BASE}/people/${player}/stats?stats=gameLog&season=${season}&group=${group}&sportId=1`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`MLB gamelog returned ${r.status}`);
      const data = await r.json();
      const splits = (data.stats?.[0]?.splits || []).slice(0, parseInt(limit));

      return res.status(200).json({
        type: "gamelog",
        group,
        playerId: player,
        season,
        games: splits.map(g => {
          const s = g.stat || {};
          const base = {
            date: g.date,
            opponent: g.opponent?.name || g.team?.name,
            homeAway: g.isHome ? "H" : "A",
          };
          if (group === "hitting") {
            return {
              ...base,
              atBats: s.atBats,
              hits: s.hits,
              doubles: s.doubles,
              triples: s.triples,
              homeRuns: s.homeRuns,
              rbi: s.rbi,
              walks: s.baseOnBalls,
              strikeouts: s.strikeOuts,
              totalBases: s.totalBases,
              avg: s.avg,
              ops: s.ops,
            };
          } else {
            return {
              ...base,
              inningsPitched: s.inningsPitched,
              hits: s.hits,
              runs: s.runs,
              earnedRuns: s.earnedRuns,
              walks: s.baseOnBalls,
              strikeouts: s.strikeOuts,
              homeRuns: s.homeRuns,
              era: s.era,
              pitchesThrown: s.numberOfPitches,
              strikes: s.strikes,
              win: s.wins > 0,
              loss: s.losses > 0,
            };
          }
        })
      });
    }

    // ── TEAM roster ──────────────────────────────────────────────────────────
    if (type === "team" && team) {
      // First find team ID if abbreviation passed
      let teamId = team;
      if (isNaN(team)) {
        const teamsUrl = `${BASE}/teams?sportId=1&season=${season}`;
        const tr = await fetch(teamsUrl);
        const td = await tr.json();
        const found = (td.teams || []).find(t =>
          t.abbreviation?.toLowerCase() === team.toLowerCase() ||
          t.teamName?.toLowerCase().includes(team.toLowerCase()) ||
          t.name?.toLowerCase().includes(team.toLowerCase())
        );
        if (found) teamId = found.id;
      }

      const url = `${BASE}/teams/${teamId}/roster?rosterType=active&season=${season}&hydrate=person(stats(type=season,group=hitting,season=${season}))`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`MLB roster returned ${r.status}`);
      const data = await r.json();

      return res.status(200).json({
        type: "team",
        teamId,
        season,
        roster: (data.roster || []).map(p => ({
          playerId: p.person?.id,
          name: p.person?.fullName,
          number: p.jerseyNumber,
          position: p.position?.abbreviation,
          status: p.status?.description,
        }))
      });
    }

    // ── SCHEDULE with probable pitchers ─────────────────────────────────────
    if (type === "schedule") {
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      const url = `${BASE}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,linescore,team`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`MLB schedule returned ${r.status}`);
      const data = await r.json();

      const games = [];
      for (const day of data.dates || []) {
        for (const g of day.games || []) {
          games.push({
            gameId: g.gamePk,
            date: g.gameDate,
            status: g.status?.detailedState,
            home: {
              team: g.teams?.home?.team?.name,
              teamId: g.teams?.home?.team?.id,
              abbreviation: g.teams?.home?.team?.abbreviation,
              probablePitcher: g.teams?.home?.probablePitcher
                ? { id: g.teams.home.probablePitcher.id, name: g.teams.home.probablePitcher.fullName }
                : null,
              score: g.teams?.home?.score,
            },
            away: {
              team: g.teams?.away?.team?.name,
              teamId: g.teams?.away?.team?.id,
              abbreviation: g.teams?.away?.team?.abbreviation,
              probablePitcher: g.teams?.away?.probablePitcher
                ? { id: g.teams.away.probablePitcher.id, name: g.teams.away.probablePitcher.fullName }
                : null,
              score: g.teams?.away?.score,
            },
            venue: g.venue?.name,
            innings: g.linescore?.currentInning,
          });
        }
      }

      return res.status(200).json({ type: "schedule", date, games });
    }

    // ── STAT LEADERS ─────────────────────────────────────────────────────────
    if (type === "leaders") {
      const cat = req.query.stat || "battingAverage";
      const url = `${BASE}/stats/leaders?leaderCategories=${cat}&season=${season}&sportId=1&limit=20&hydrate=person,team`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`MLB leaders returned ${r.status}`);
      const data = await r.json();
      const leaders = data.leagueLeaders?.[0]?.leaders || [];

      return res.status(200).json({
        type: "leaders",
        season,
        stat: cat,
        leaders: leaders.map(l => ({
          rank: l.rank,
          playerId: l.person?.id,
          name: l.person?.fullName,
          team: l.team?.abbreviation,
          value: l.value,
        }))
      });
    }

    // ── PITCHER vs TEAM matchup history ─────────────────────────────────────
    if (type === "vsTeam" && player && team) {
      const url = `${BASE}/people/${player}/stats?stats=vsTeam&season=${season}&group=${group}&opposingTeamId=${team}&sportId=1`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`MLB vsTeam returned ${r.status}`);
      const data = await r.json();
      const s = data.stats?.[0]?.splits?.[0]?.stat || {};

      return res.status(200).json({
        type: "vsTeam",
        playerId: player,
        opposingTeamId: team,
        season,
        stats: s
      });
    }

    return res.status(400).json({
      error: "Invalid type",
      validTypes: ["search", "stats", "gamelog", "team", "schedule", "leaders", "vsTeam"],
      examples: [
        "/api/mlb?type=search&player=Shohei+Ohtani",
        "/api/mlb?type=stats&player=660271&group=hitting&season=2025",
        "/api/mlb?type=stats&player=660271&group=pitching&season=2025",
        "/api/mlb?type=gamelog&player=660271&group=hitting&limit=10",
        "/api/mlb?type=team&team=NYY&season=2025",
        "/api/mlb?type=schedule&date=2025-04-15",
        "/api/mlb?type=leaders&stat=homeRuns&season=2025",
        "/api/mlb?type=vsTeam&player=660271&team=147",
      ]
    });

  } catch (err) {
    console.error("MLB API error:", err);
    return res.status(500).json({ error: "MLB API error", detail: err.message });
  }
}
