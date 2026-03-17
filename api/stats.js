// api/stats.js — ALL pro sports stats consolidated
// sport=nhl | nba | mlb | nfl

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { sport, type, player, team, season, limit = "10", group = "hitting", week } = req.query;

  if (!sport) return res.status(400).json({
    error: "sport param required",
    validSports: ["nhl", "nba", "mlb", "nfl"],
    examples: [
      "/api/stats?sport=nhl&type=search&player=Nathan+MacKinnon",
      "/api/stats?sport=nba&type=search&player=LeBron+James&season=2025",
      "/api/stats?sport=mlb&type=search&player=Shohei+Ohtani&season=2025",
      "/api/stats?sport=nfl&type=teams",
    ]
  });

  // ══════════════════════════════════════════════════════════════════════════
  // NHL — api-web.nhle.com + api.nhle.com/stats/rest
  // ══════════════════════════════════════════════════════════════════════════
  if (sport === "nhl") {
    const NHL_SEASON = season || "20242025";
    try {
      if (type === "raw") {
        const path = req.query.path || `seasons?seasonId=${NHL_SEASON}`;
        const r = await fetch(`https://api-web.nhle.com/v1/${path}`);
        return res.status(200).json({ status: r.status, preview: (await r.text()).slice(0, 2000) });
      }

      if (type === "search" && player) {
        const r = await fetch(`https://api.nhle.com/stats/rest/en/skater/summary?isAggregate=false&isGame=false&sort=%5B%7B%22property%22%3A%22points%22%2C%22direction%22%3A%22DESC%22%7D%5D&start=0&limit=500&factCayenneExp=gamesPlayed%3E=1&cayenneExp=seasonId=${NHL_SEASON}%20and%20gameTypeId=2`);
        if (!r.ok) throw new Error(`NHL search returned ${r.status}`);
        const data = await r.json();
        const q = player.toLowerCase();
        const matches = (data.data || []).filter(p => q.split(" ").every(w => (p.skaterFullName||"").toLowerCase().includes(w))).slice(0,10);
        return res.status(200).json({ type:"search", results: matches.map(p => ({
          playerId:p.playerId, name:p.skaterFullName, team:p.teamAbbrevs, position:p.positionCode,
          gamesPlayed:p.gamesPlayed, goals:p.goals, assists:p.assists, points:p.points,
          pointsPerGame:p.gamesPlayed>0?(p.points/p.gamesPlayed).toFixed(2):"0.00",
          shots:p.shots, toi:p.timeOnIcePerGame, powerPlayPoints:p.ppPoints, plusMinus:p.plusMinus,
        })) });
      }

      if (type === "stats" && player) {
        const r = await fetch(`https://api-web.nhle.com/v1/player/${player}/landing`);
        if (!r.ok) throw new Error(`NHL stats returned ${r.status}`);
        const data = await r.json();
        const cur = data.featuredStats?.regularSeason?.subSeason;
        return res.status(200).json({ type:"stats", playerId:player,
          name:`${data.firstName?.default||""} ${data.lastName?.default||""}`.trim(),
          team:data.currentTeamAbbrev, position:data.position,
          currentSeason: cur ? { season:data.featuredStats?.season, gamesPlayed:cur.gamesPlayed,
            goals:cur.goals, assists:cur.assists, points:cur.points,
            pointsPerGame:cur.gamesPlayed>0?(cur.points/cur.gamesPlayed).toFixed(2):"0.00",
            goalsPerGame:cur.gamesPlayed>0?(cur.goals/cur.gamesPlayed).toFixed(2):"0.00",
            shotsPerGame:cur.shots&&cur.gamesPlayed>0?(cur.shots/cur.gamesPlayed).toFixed(1):null,
            powerPlayPoints:cur.powerPlayPoints, plusMinus:cur.plusMinus } : null });
      }

      if (type === "gamelog" && player) {
        const r = await fetch(`https://api-web.nhle.com/v1/player/${player}/game-log/${NHL_SEASON}/2`);
        if (!r.ok) throw new Error(`NHL gamelog returned ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ type:"gamelog", playerId:player, season:NHL_SEASON,
          games: (data.gameLog||[]).slice(0,parseInt(limit)).map(g => ({
            date:g.gameDate, opponent:g.opponentAbbrev, homeAway:g.homeRoadFlag,
            goals:g.goals, assists:g.assists, points:g.points, shots:g.shots,
            toi:g.toi, powerPlayPoints:g.powerPlayPoints, plusMinus:g.plusMinus })) });
      }

      if (type === "team" && team) {
        const r = await fetch(`https://api-web.nhle.com/v1/roster/${team.toUpperCase()}/current`);
        if (!r.ok) throw new Error(`NHL roster returned ${r.status}`);
        const data = await r.json();
        const all = [...(data.forwards||[]),...(data.defensemen||[]),...(data.goalies||[])];
        return res.status(200).json({ type:"team", team:team.toUpperCase(),
          roster: all.map(p => ({ playerId:p.id, name:`${p.firstName?.default||""} ${p.lastName?.default||""}`.trim(),
            number:p.sweaterNumber, position:p.positionCode })) });
      }

      if (type === "goalie" && team) {
        const r = await fetch(`https://api-web.nhle.com/v1/club-stats/${team.toUpperCase()}/now`);
        if (!r.ok) throw new Error(`NHL goalie returned ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ type:"goalie", team:team.toUpperCase(),
          goalies: (data.goalies||[]).map(g => ({ playerId:g.playerId,
            name:`${g.firstName?.default||""} ${g.lastName?.default||""}`.trim(),
            gamesPlayed:g.gamesPlayed, wins:g.wins, savePercentage:g.savePercentage,
            goalsAgainstAverage:g.goalsAgainstAverage, shutouts:g.shutouts })) });
      }

      if (type === "schedule" && team) {
        const r = await fetch(`https://api-web.nhle.com/v1/club-schedule/${team.toUpperCase()}/week/now`);
        if (!r.ok) throw new Error(`NHL schedule returned ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ type:"schedule", team:team.toUpperCase(),
          games: (data.games||[]).map(g => ({ gameId:g.id, date:g.gameDate,
            home:g.homeTeam?.abbrev, away:g.awayTeam?.abbrev, status:g.gameState })) });
      }

      if (type === "leaders") {
        const r = await fetch(`https://api.nhle.com/stats/rest/en/skater/summary?isAggregate=false&isGame=false&sort=%5B%7B%22property%22%3A%22points%22%2C%22direction%22%3A%22DESC%22%7D%5D&start=0&limit=25&factCayenneExp=gamesPlayed%3E=1&cayenneExp=seasonId=${NHL_SEASON}%20and%20gameTypeId=2`);
        const data = await r.json();
        return res.status(200).json({ type:"leaders",
          skaters: (data.data||[]).map(p => ({ playerId:p.playerId, name:p.skaterFullName,
            team:p.teamAbbrevs, position:p.positionCode, gamesPlayed:p.gamesPlayed,
            goals:p.goals, assists:p.assists, points:p.points,
            pointsPerGame:p.gamesPlayed>0?(p.points/p.gamesPlayed).toFixed(2):"0.00" })) });
      }

      return res.status(400).json({ error:"Invalid type for NHL", validTypes:["search","stats","gamelog","team","goalie","schedule","leaders"] });
    } catch(err) { return res.status(500).json({ error:"NHL API error", detail:err.message }); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // NBA — api.server.nbaapi.com + stats.nba.com
  // ══════════════════════════════════════════════════════════════════════════
  if (sport === "nba") {
    const NBA_SEASON = season || "2025";
    const NBA_HEADERS = {
      "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Referer":"https://www.nba.com/","Origin":"https://www.nba.com","Accept":"application/json",
      "x-nba-stats-origin":"stats","x-nba-stats-token":"true",
    };
    try {
      if (type === "search" && player) {
        const r = await fetch(`https://api.server.nbaapi.com/api/playertotals?season=${NBA_SEASON}&page=1&pageSize=500&sortBy=points&ascending=false`,{headers:{"Accept":"application/json"}});
        if (!r.ok) throw new Error(`NBA search returned ${r.status}`);
        const data = await r.json();
        const q = player.toLowerCase();
        const matches = (data.data||[]).filter(p=>q.split(" ").every(w=>(p.playerName||"").toLowerCase().includes(w))).slice(0,10);
        return res.status(200).json({ type:"search", season:NBA_SEASON,
          results: matches.map(p=>({ playerId:p.playerId, name:p.playerName, team:p.team,
            position:p.position, gamesPlayed:p.games, minutesPerGame:p.minutesPg,
            pointsPerGame:p.points, reboundsPerGame:p.totalRb, assistsPerGame:p.assists,
            stealsPerGame:p.steals, blocksPerGame:p.blocks, fg3PerGame:p.threeFg,
            fgPct:p.fieldPercent, ftPct:p.ftPercent })) });
      }

      if (type === "stats" && player) {
        const r = await fetch(`https://api.server.nbaapi.com/api/playertotals?playerId=${encodeURIComponent(player)}&season=${NBA_SEASON}`,{headers:{"Accept":"application/json"}});
        if (!r.ok) throw new Error(`NBA stats returned ${r.status}`);
        const data = await r.json();
        const p = data.data?.[0];
        if (!p) return res.status(200).json({ type:"stats", data:null });
        return res.status(200).json({ type:"stats", playerId:player, name:p.playerName,
          team:p.team, position:p.position, season:NBA_SEASON,
          averages:{ gamesPlayed:p.games, minutesPerGame:p.minutesPg, pointsPerGame:p.points,
            reboundsPerGame:p.totalRb, assistsPerGame:p.assists, stealsPerGame:p.steals,
            blocksPerGame:p.blocks, turnoversPerGame:p.turnovers, fg3PerGame:p.threeFg,
            fg3Pct:p.threePercent, fgPct:p.fieldPercent, ftPct:p.ftPercent } });
      }

      if (type === "advanced" && player) {
        const r = await fetch(`https://api.server.nbaapi.com/api/playeradvancedstats?playerId=${encodeURIComponent(player)}&season=${NBA_SEASON}`,{headers:{"Accept":"application/json"}});
        if (!r.ok) throw new Error(`NBA advanced returned ${r.status}`);
        const data = await r.json();
        const p = data.data?.[0];
        if (!p) return res.status(200).json({ type:"advanced", data:null });
        return res.status(200).json({ type:"advanced", playerId:player, name:p.playerName, team:p.team,
          advanced:{ per:p.per, tsPercent:p.tsPercent, usagePercent:p.usagePercent,
            assistPercent:p.assistPercent, reboundPercent:p.totalRBPercent,
            winShares:p.winShares, vorp:p.vorp } });
      }

      if (type === "gamelog" && player) {
        const seasonStr = `${parseInt(NBA_SEASON)-1}-${NBA_SEASON.slice(2)}`;
        const r = await fetch(`https://stats.nba.com/stats/playergamelog?PlayerID=${player}&Season=${seasonStr}&SeasonType=Regular+Season`,{headers:NBA_HEADERS});
        if (!r.ok) throw new Error(`NBA gamelog returned ${r.status}`);
        const data = await r.json();
        const headers = data.resultSets?.[0]?.headers||[];
        const rows = (data.resultSets?.[0]?.rowSet||[]).slice(0,parseInt(limit));
        const idx = n => headers.indexOf(n);
        return res.status(200).json({ type:"gamelog", playerId:player, season:seasonStr,
          games: rows.map(row=>({ date:row[idx("GAME_DATE")], matchup:row[idx("MATCHUP")],
            result:row[idx("WL")], minutes:row[idx("MIN")], points:row[idx("PTS")],
            rebounds:row[idx("REB")], assists:row[idx("AST")], steals:row[idx("STL")],
            blocks:row[idx("BLK")], fg3Made:row[idx("FG3M")], plusMinus:row[idx("PLUS_MINUS")] })) });
      }

      if (type === "leaders") {
        const stat = req.query.stat||"points";
        const r = await fetch(`https://api.server.nbaapi.com/api/playertotals?season=${NBA_SEASON}&page=1&pageSize=25&sortBy=${stat}&ascending=false`,{headers:{"Accept":"application/json"}});
        const data = await r.json();
        return res.status(200).json({ type:"leaders", season:NBA_SEASON, sortedBy:stat,
          players:(data.data||[]).map(p=>({ playerId:p.playerId, name:p.playerName, team:p.team,
            gamesPlayed:p.games, pointsPerGame:p.points, reboundsPerGame:p.totalRb,
            assistsPerGame:p.assists, minutesPerGame:p.minutesPg })) });
      }

      if (type === "team" && team) {
        const r = await fetch(`https://api.server.nbaapi.com/api/playertotals?team=${encodeURIComponent(team.toUpperCase())}&season=${NBA_SEASON}&page=1&pageSize=20&sortBy=minutesPg&ascending=false`,{headers:{"Accept":"application/json"}});
        const data = await r.json();
        return res.status(200).json({ type:"team", team:team.toUpperCase(), season:NBA_SEASON,
          players:(data.data||[]).map(p=>({ playerId:p.playerId, name:p.playerName,
            position:p.position, gamesPlayed:p.games, minutesPerGame:p.minutesPg,
            pointsPerGame:p.points, reboundsPerGame:p.totalRb, assistsPerGame:p.assists })) });
      }

      return res.status(400).json({ error:"Invalid type for NBA", validTypes:["search","stats","advanced","gamelog","leaders","team"] });
    } catch(err) { return res.status(500).json({ error:"NBA API error", detail:err.message }); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MLB — statsapi.mlb.com
  // ══════════════════════════════════════════════════════════════════════════
  if (sport === "mlb") {
    const MLB_SEASON = season || "2025";
    const BASE = "https://statsapi.mlb.com/api/v1";
    try {
      if (type === "search" && player) {
        const r = await fetch(`${BASE}/sports/1/players?season=${MLB_SEASON}&gameType=R`);
        if (!r.ok) throw new Error(`MLB players returned ${r.status}`);
        const data = await r.json();
        const q = player.toLowerCase();
        const matches = (data.people||[]).filter(p=>q.split(" ").every(w=>(p.fullName||"").toLowerCase().includes(w))).slice(0,10);
        return res.status(200).json({ type:"search",
          results: matches.map(p=>({ playerId:p.id, name:p.fullName, team:p.currentTeam?.name,
            teamId:p.currentTeam?.id, position:p.primaryPosition?.abbreviation,
            batSide:p.batSide?.code, pitchHand:p.pitchHand?.code, age:p.currentAge })) });
      }

      if (type === "stats" && player) {
        const r = await fetch(`${BASE}/people/${player}/stats?stats=season&season=${MLB_SEASON}&group=${group}&sportId=1`);
        if (!r.ok) throw new Error(`MLB stats returned ${r.status}`);
        const data = await r.json();
        const s = data.stats?.[0]?.splits?.[0]?.stat||{};
        const gp = parseInt(s.gamesPlayed||s.gamesPitched||0);
        const pr = await fetch(`${BASE}/people/${player}`);
        const profile = await pr.json();
        const p = profile.people?.[0]||{};
        if (group === "hitting") {
          return res.status(200).json({ type:"stats", group:"hitting", playerId:player,
            name:p.fullName, team:p.currentTeam?.name, season:MLB_SEASON,
            stats:{ gamesPlayed:gp, hits:s.hits, hitsPerGame:gp>0?(parseInt(s.hits||0)/gp).toFixed(2):"0.00",
              homeRuns:s.homeRuns, homeRunsPerGame:gp>0?(parseInt(s.homeRuns||0)/gp).toFixed(3):"0.000",
              rbi:s.rbi, walks:s.baseOnBalls, strikeouts:s.strikeOuts,
              avg:s.avg, obp:s.obp, slg:s.slg, ops:s.ops,
              totalBases:s.totalBases, totalBasesPerGame:gp>0?(parseInt(s.totalBases||0)/gp).toFixed(2):"0.00" } });
        } else {
          return res.status(200).json({ type:"stats", group:"pitching", playerId:player,
            name:p.fullName, team:p.currentTeam?.name, season:MLB_SEASON,
            stats:{ gamesPitched:s.gamesPitched, gamesStarted:s.gamesStarted, era:s.era,
              inningsPitched:s.inningsPitched, hits:s.hits, earnedRuns:s.earnedRuns,
              homeRuns:s.homeRuns, walks:s.baseOnBalls, strikeouts:s.strikeOuts,
              whip:s.whip, strikeoutsPer9:s.strikeoutsPer9Inn, saves:s.saves } });
        }
      }

      if (type === "gamelog" && player) {
        const r = await fetch(`${BASE}/people/${player}/stats?stats=gameLog&season=${MLB_SEASON}&group=${group}&sportId=1`);
        if (!r.ok) throw new Error(`MLB gamelog returned ${r.status}`);
        const data = await r.json();
        const splits = (data.stats?.[0]?.splits||[]).slice(0,parseInt(limit));
        return res.status(200).json({ type:"gamelog", group, playerId:player, season:MLB_SEASON,
          games: splits.map(g=>{ const s=g.stat||{};
            return group==="hitting"
              ? { date:g.date, opponent:g.opponent?.name, homeAway:g.isHome?"H":"A",
                  hits:s.hits, homeRuns:s.homeRuns, rbi:s.rbi, walks:s.baseOnBalls,
                  strikeouts:s.strikeOuts, totalBases:s.totalBases, avg:s.avg }
              : { date:g.date, opponent:g.opponent?.name, homeAway:g.isHome?"H":"A",
                  inningsPitched:s.inningsPitched, hits:s.hits, earnedRuns:s.earnedRuns,
                  walks:s.baseOnBalls, strikeouts:s.strikeOuts, era:s.era, pitchesThrown:s.numberOfPitches }; }) });
      }

      if (type === "schedule") {
        const date = req.query.date||new Date().toISOString().slice(0,10);
        const r = await fetch(`${BASE}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team`);
        if (!r.ok) throw new Error(`MLB schedule returned ${r.status}`);
        const data = await r.json();
        const games = [];
        for (const day of data.dates||[]) for (const g of day.games||[]) {
          games.push({ gameId:g.gamePk, date:g.gameDate, status:g.status?.detailedState,
            home:{ team:g.teams?.home?.team?.name, abbrev:g.teams?.home?.team?.abbreviation,
              probablePitcher:g.teams?.home?.probablePitcher?{id:g.teams.home.probablePitcher.id,name:g.teams.home.probablePitcher.fullName}:null },
            away:{ team:g.teams?.away?.team?.name, abbrev:g.teams?.away?.team?.abbreviation,
              probablePitcher:g.teams?.away?.probablePitcher?{id:g.teams.away.probablePitcher.id,name:g.teams.away.probablePitcher.fullName}:null },
            venue:g.venue?.name });
        }
        return res.status(200).json({ type:"schedule", date, games });
      }

      if (type === "leaders") {
        const cat = req.query.stat||"battingAverage";
        const r = await fetch(`${BASE}/stats/leaders?leaderCategories=${cat}&season=${MLB_SEASON}&sportId=1&limit=20&hydrate=person,team`);
        if (!r.ok) throw new Error(`MLB leaders returned ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ type:"leaders", season:MLB_SEASON, stat:cat,
          leaders:(data.leagueLeaders?.[0]?.leaders||[]).map(l=>({ rank:l.rank,
            playerId:l.person?.id, name:l.person?.fullName, team:l.team?.abbreviation, value:l.value })) });
      }

      if (type === "team" && team) {
        let teamId = team;
        if (isNaN(team)) {
          const tr = await fetch(`${BASE}/teams?sportId=1&season=${MLB_SEASON}`);
          const td = await tr.json();
          const found = (td.teams||[]).find(t=>t.abbreviation?.toLowerCase()===team.toLowerCase()||t.name?.toLowerCase().includes(team.toLowerCase()));
          if (found) teamId = found.id;
        }
        const r = await fetch(`${BASE}/teams/${teamId}/roster?rosterType=active&season=${MLB_SEASON}`);
        if (!r.ok) throw new Error(`MLB roster returned ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ type:"team", teamId, season:MLB_SEASON,
          roster:(data.roster||[]).map(p=>({ playerId:p.person?.id, name:p.person?.fullName,
            number:p.jerseyNumber, position:p.position?.abbreviation })) });
      }

      return res.status(400).json({ error:"Invalid type for MLB", validTypes:["search","stats","gamelog","schedule","leaders","team"] });
    } catch(err) { return res.status(500).json({ error:"MLB API error", detail:err.message }); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // NFL — ESPN API
  // ══════════════════════════════════════════════════════════════════════════
  if (sport === "nfl") {
    const NFL_SEASON = season || "2025";
    const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
    const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
    try {
      if (type === "search" && player) {
        const r = await fetch(`https://site.web.api.espn.com/apis/search/v2?limit=10&query=${encodeURIComponent(player)}&sport=football&league=nfl`);
        if (!r.ok) throw new Error(`NFL search returned ${r.status}`);
        const data = await r.json();
        const athletes = [];
        for (const group of (data.results||[])) for (const item of (group.contents||[])) {
          if (group.type==="athlete"||item.type==="athlete") athletes.push({ playerId:item.id,
            name:item.displayName, team:item.teamDisplayName, position:item.position });
        }
        return res.status(200).json({ type:"search", results:athletes.slice(0,10) });
      }

      if (type === "stats" && player) {
        const r = await fetch(`${SITE}/athletes/${player}/statistics`);
        if (!r.ok) throw new Error(`NFL stats returned ${r.status}`);
        const data = await r.json();
        const parsed = {};
        for (const cat of (data.splits?.categories||[])) {
          const vals = {}; const names = cat.names||[]; const values = cat.splits?.[0]?.stats||[];
          names.forEach((n,i)=>{ vals[n]=values[i]; });
          parsed[cat.displayName||cat.name] = vals;
        }
        return res.status(200).json({ type:"stats", playerId:player,
          name:data.athlete?.displayName, team:data.athlete?.team?.displayName,
          position:data.athlete?.position?.abbreviation, stats:parsed });
      }

      if (type === "teams") {
        const r = await fetch(`${SITE}/teams`);
        if (!r.ok) throw new Error(`NFL teams returned ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ type:"teams",
          teams:(data.sports?.[0]?.leagues?.[0]?.teams||[]).map(t=>({ teamId:t.team.id,
            name:t.team.displayName, abbreviation:t.team.abbreviation, location:t.team.location })) });
      }

      if (type === "team" && team) {
        const r = await fetch(`${SITE}/teams/${team}?enable=roster,stats`);
        if (!r.ok) throw new Error(`NFL team returned ${r.status}`);
        const data = await r.json();
        const t = data.team||{};
        return res.status(200).json({ type:"team", teamId:team, name:t.displayName,
          abbreviation:t.abbreviation, record:t.record?.items?.[0]?.summary,
          roster:(t.athletes||[]).map(a=>({ playerId:a.id, name:a.displayName,
            position:a.position?.abbreviation, jersey:a.jersey, status:a.status?.type })) });
      }

      if (type === "injuries" && team) {
        const r = await fetch(`${CORE}/teams/${team}/injuries`);
        if (!r.ok) throw new Error(`NFL injuries returned ${r.status}`);
        const data = await r.json();
        const injuries = [];
        for (const item of (data.items||[]).slice(0,15)) {
          try { const ir = await fetch(item.$ref); const id = await ir.json();
            injuries.push({ player:id.athlete?.displayName, status:id.status,
              type:id.type?.description, detail:id.shortComment }); } catch {}
        }
        return res.status(200).json({ type:"injuries", teamId:team, injuries });
      }

      if (type === "schedule") {
        let url = `${SITE}/scoreboard`;
        if (week) url += `?seasontype=2&week=${week}&dates=${NFL_SEASON}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`NFL scoreboard returned ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ type:"schedule", week:data.week?.number, season:data.season?.year,
          games:(data.events||[]).map(e=>{ const comp=e.competitions?.[0];
            const home=comp?.competitors?.find(c=>c.homeAway==="home");
            const away=comp?.competitors?.find(c=>c.homeAway==="away");
            return { gameId:e.id, date:e.date, status:e.status?.type?.description,
              home:{team:home?.team?.displayName,abbrev:home?.team?.abbreviation,score:home?.score,record:home?.records?.[0]?.summary},
              away:{team:away?.team?.displayName,abbrev:away?.team?.abbreviation,score:away?.score,record:away?.records?.[0]?.summary},
              venue:comp?.venue?.fullName, spread:comp?.odds?.[0]?.details, overUnder:comp?.odds?.[0]?.overUnder }; }) });
      }

      if (type === "news" && team) {
        const r = await fetch(`${SITE}/news?team=${team}&limit=5`);
        if (!r.ok) throw new Error(`NFL news returned ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ type:"news", teamId:team,
          articles:(data.articles||[]).slice(0,5).map(a=>({ headline:a.headline, description:a.description, published:a.published })) });
      }

      return res.status(400).json({ error:"Invalid type for NFL", validTypes:["search","stats","teams","team","injuries","schedule","news"] });
    } catch(err) { return res.status(500).json({ error:"NFL API error", detail:err.message }); }
  }

  return res.status(400).json({ error:"Invalid sport", validSports:["nhl","nba","mlb","nfl"] });
}
