// api/other.js — Soccer + NCAA Basketball/Football consolidated
// sport=soccer (default) | sport=ncaa

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { sport = "soccer" } = req.query;

  // ══════════════════════════════════════════════════════════════════════════
  // SOCCER — ESPN API
  // ══════════════════════════════════════════════════════════════════════════
  if (sport === "soccer") {
    const { type, player, team, league, date, limit = "10" } = req.query;

    const LEAGUE_SLUGS = {
      "epl":"eng.1","premier league":"eng.1","english premier":"eng.1",
      "la liga":"esp.1","laliga":"esp.1","spain":"esp.1",
      "bundesliga":"ger.1","germany":"ger.1",
      "serie a":"ita.1","italy":"ita.1",
      "ligue 1":"fra.1","france":"fra.1",
      "mls":"usa.1","major league soccer":"usa.1",
      "champions league":"uefa.champions","ucl":"uefa.champions",
      "europa league":"uefa.europa","uel":"uefa.europa",
      "conference league":"uefa.europa.conf",
      "world cup":"fifa.world","euros":"uefa.euro",
      "eredivisie":"ned.1","netherlands":"ned.1",
      "primeira liga":"por.1","portugal":"por.1",
      "scottish premiership":"sco.1","scotland":"sco.1",
    };

    if (type === "leagues") {
      return res.status(200).json({ type:"leagues",
        supported:Object.entries(LEAGUE_SLUGS).map(([name,slug])=>({name,slug})) });
    }

    const leagueSlug = (() => {
      if (!league) return "eng.1";
      const key = league.toLowerCase().trim();
      return LEAGUE_SLUGS[key] || league;
    })();

    const SITE = `https://site.api.espn.com/apis/site/v2/sports/soccer/${leagueSlug}`;

    try {
      if (type === "scoreboard" || type === "schedule") {
        let url = `${SITE}/scoreboard`;
        if (date) url += `?dates=${date.replace(/-/g,"")}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`ESPN soccer scoreboard returned ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ type:"scoreboard", league:leagueSlug,
          games:(data.events||[]).map(e=>{
            const comp=e.competitions?.[0];
            const home=comp?.competitors?.find(c=>c.homeAway==="home");
            const away=comp?.competitors?.find(c=>c.homeAway==="away");
            return { gameId:e.id, date:e.date, name:e.name, status:e.status?.type?.description,
              minute:e.status?.displayClock,
              home:{teamId:home?.team?.id,team:home?.team?.displayName,abbrev:home?.team?.abbreviation,score:home?.score},
              away:{teamId:away?.team?.id,team:away?.team?.displayName,abbrev:away?.team?.abbreviation,score:away?.score},
              venue:comp?.venue?.fullName,
              odds:comp?.odds?.[0]?{details:comp.odds[0].details,overUnder:comp.odds[0].overUnder,
                homeOdds:comp.odds[0].homeTeamOdds?.moneyLine,awayOdds:comp.odds[0].awayTeamOdds?.moneyLine}:null }; }) });
      }

      if (type === "standings") {
        const r = await fetch(`${SITE}/standings`);
        if (!r.ok) throw new Error(`ESPN standings returned ${r.status}`);
        const data = await r.json();
        const table = [];
        for (const group of (data.standings?.entries||[])) {
          const stats = {}; (group.stats||[]).forEach(s=>{stats[s.abbreviation||s.name]=s.displayValue;});
          table.push({ team:group.team?.displayName, teamId:group.team?.id, abbrev:group.team?.abbreviation,
            gamesPlayed:stats.GP, wins:stats.W, draws:stats.D, losses:stats.L,
            goalsFor:stats.GF, goalsAgainst:stats.GA, goalDiff:stats.GD, points:stats.PTS });
        }
        return res.status(200).json({ type:"standings", league:leagueSlug, table });
      }

      if (type === "team" && team) {
        const r = await fetch(`${SITE}/teams/${team}`);
        if (!r.ok) throw new Error(`ESPN team returned ${r.status}`);
        const data = await r.json();
        const t = data.team||{};
        const sr = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/${team}/schedule`);
        const sched = await sr.json();
        const recent = (sched.events||[]).filter(e=>e.status?.type?.completed).slice(-5).map(e=>{
          const comp=e.competitions?.[0];
          const mine=comp?.competitors?.find(c=>c.team?.id==team);
          const opp=comp?.competitors?.find(c=>c.team?.id!=team);
          return { date:e.date?.slice(0,10), opponent:opp?.team?.displayName,
            result:mine?.winner?"W":(opp?.winner?"L":"D"), score:`${mine?.score}-${opp?.score}`, homeAway:mine?.homeAway };
        });
        return res.status(200).json({ type:"team", teamId:team, name:t.displayName,
          abbreviation:t.abbreviation, record:t.record?.items?.[0]?.summary,
          venue:t.venue?.fullName, recentForm:recent });
      }

      if (type === "search" && player) {
        const r = await fetch(`https://site.web.api.espn.com/apis/search/v2?limit=10&query=${encodeURIComponent(player)}&sport=soccer`);
        if (!r.ok) throw new Error(`ESPN search returned ${r.status}`);
        const data = await r.json();
        const players = [];
        for (const group of (data.results||[])) for (const item of (group.contents||[])) {
          if (item.type==="athlete"||group.type==="athlete")
            players.push({ playerId:item.id, name:item.displayName, team:item.teamDisplayName });
        }
        return res.status(200).json({ type:"search", query:player, results:players.slice(0,10) });
      }

      if (type === "leaders") {
        const r = await fetch(`${SITE}/leaders`);
        if (!r.ok) throw new Error(`ESPN leaders returned ${r.status}`);
        const data = await r.json();
        const categories = {};
        for (const cat of (data.leaders||[])) {
          categories[cat.displayName||cat.name]=(cat.leaders||[]).slice(0,10).map(l=>({
            rank:l.rank, name:l.athlete?.displayName, team:l.team?.displayName, value:l.value }));
        }
        return res.status(200).json({ type:"leaders", league:leagueSlug, categories });
      }

      if (type === "news") {
        const r = await fetch(`${SITE}/news?limit=5`);
        if (!r.ok) throw new Error(`ESPN news returned ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ type:"news", league:leagueSlug,
          articles:(data.articles||[]).slice(0,5).map(a=>({headline:a.headline,description:a.description,published:a.published})) });
      }

      return res.status(400).json({ error:"Invalid type for soccer",
        validTypes:["leagues","scoreboard","standings","team","search","leaders","news"] });

    } catch(err) { return res.status(500).json({ error:"Soccer API error", detail:err.message }); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // NCAA — ESPN API (Basketball + Football)
  // ══════════════════════════════════════════════════════════════════════════
  if (sport === "ncaa") {
    const { type, player, team, date, limit = "10", gender = "mens", ncaasport = "basketball" } = req.query;

    const ESPORT = ncaasport === "football" ? "football" : "basketball";
    const LEAGUE = ncaasport === "football" ? "college-football" : `${gender}-college-basketball`;
    const SITE = `https://site.api.espn.com/apis/site/v2/sports/${ESPORT}/${LEAGUE}`;
    const CORE = `https://sports.core.api.espn.com/v2/sports/${ESPORT}/leagues/${LEAGUE}`;

    try {
      if (type === "raw") {
        const url = `${SITE}/scoreboard`;
        const r = await fetch(url);
        const text = await r.text();
        return res.status(200).json({ status:r.status, url, preview:text.slice(0,2000) });
      }

      if (type === "scoreboard") {
        let url = `${SITE}/scoreboard`;
        if (date) url += `?dates=${date.replace(/-/g,"")}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`ESPN NCAAB scoreboard returned ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ type:"scoreboard", league:LEAGUE,
          games:(data.events||[]).map(e=>{
            const comp=e.competitions?.[0];
            const home=comp?.competitors?.find(c=>c.homeAway==="home");
            const away=comp?.competitors?.find(c=>c.homeAway==="away");
            return { gameId:e.id, date:e.date, name:e.name, status:e.status?.type?.description,
              home:{teamId:home?.team?.id, team:home?.team?.displayName, abbrev:home?.team?.abbreviation,
                score:home?.score, rank:home?.curatedRank?.current, record:home?.records?.[0]?.summary},
              away:{teamId:away?.team?.id, team:away?.team?.displayName, abbrev:away?.team?.abbreviation,
                score:away?.score, rank:away?.curatedRank?.current, record:away?.records?.[0]?.summary},
              venue:comp?.venue?.fullName, spread:comp?.odds?.[0]?.details,
              overUnder:comp?.odds?.[0]?.overUnder, broadcast:comp?.broadcasts?.[0]?.names?.[0] }; }) });
      }

      if (type === "rankings") {
        const r = await fetch(`${SITE}/rankings`);
        if (!r.ok) throw new Error(`ESPN rankings returned ${r.status}`);
        const data = await r.json();
        const poll = data.rankings?.[0];
        return res.status(200).json({ type:"rankings", league:LEAGUE, pollName:poll?.name,
          rankings:(poll?.ranks||[]).map(r=>({ rank:r.current, previousRank:r.previous,
            teamId:r.team?.id, team:r.team?.displayName, record:r.recordSummary, points:r.points })) });
      }

      if (type === "standings") {
        const r = await fetch(`${SITE}/standings`);
        if (!r.ok) throw new Error(`ESPN standings returned ${r.status}`);
        const data = await r.json();
        const conferences = [];
        for (const group of (data.standings?.entries||data.children||[])) {
          const teams = [];
          for (const entry of (group.standings?.entries||group.entries||[])) {
            const stats = {}; (entry.stats||[]).forEach(s=>{stats[s.abbreviation||s.name]=s.displayValue;});
            teams.push({ teamId:entry.team?.id, team:entry.team?.displayName, abbrev:entry.team?.abbreviation,
              wins:stats.W||stats.wins, losses:stats.L||stats.losses, pct:stats.PCT||stats.WP });
          }
          if (teams.length) conferences.push({ conference:group.name||group.abbreviation, teams });
        }
        return res.status(200).json({ type:"standings", league:LEAGUE, conferences });
      }

      if (type === "teams") {
        const r = await fetch(`${SITE}/teams?limit=400`);
        if (!r.ok) throw new Error(`ESPN teams returned ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ type:"teams", league:LEAGUE,
          teams:(data.sports?.[0]?.leagues?.[0]?.teams||[]).map(t=>({ teamId:t.team.id,
            name:t.team.displayName, abbreviation:t.team.abbreviation, location:t.team.location })) });
      }

      if (type === "team" && team) {
        const r = await fetch(`${SITE}/teams/${team}?enable=roster,stats`);
        if (!r.ok) throw new Error(`ESPN team returned ${r.status}`);
        const data = await r.json();
        const t = data.team||{};
        return res.status(200).json({ type:"team", teamId:team, name:t.displayName,
          record:t.record?.items?.[0]?.summary, rank:t.rankSummary, venue:t.venue?.fullName,
          roster:(t.athletes||[]).slice(0,15).map(a=>({ playerId:a.id, name:a.displayName,
            position:a.position?.abbreviation, jersey:a.jersey })) });
      }

      if (type === "search" && player) {
        const r = await fetch(`https://site.web.api.espn.com/apis/search/v2?limit=10&query=${encodeURIComponent(player)}&sport=${ESPORT}`);
        if (!r.ok) throw new Error(`ESPN search returned ${r.status}`);
        const data = await r.json();
        const players = [];
        for (const group of (data.results||[])) for (const item of (group.contents||[])) {
          if (group.type==="athlete"||item.type==="athlete")
            players.push({ playerId:item.id, name:item.displayName, team:item.teamDisplayName });
        }
        return res.status(200).json({ type:"search", query:player, results:players.slice(0,10) });
      }

      if (type === "news") {
        const r = await fetch(`${SITE}/news?limit=5`);
        if (!r.ok) throw new Error(`ESPN news returned ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ type:"news", league:LEAGUE,
          articles:(data.articles||[]).slice(0,5).map(a=>({headline:a.headline,description:a.description,published:a.published})) });
      }

      return res.status(400).json({ error:"Invalid type for NCAA",
        validTypes:["scoreboard","rankings","standings","teams","team","search","news","raw"],
        note:"Add ncaasport=football for college football, gender=womens for women's basketball" });

    } catch(err) { return res.status(500).json({ error:"NCAA API error", detail:err.message }); }
  }

  return res.status(400).json({ error:"Invalid sport", validSports:["soccer","ncaa"],
    examples:[
      "/api/other?sport=soccer&type=scoreboard&league=epl",
      "/api/other?sport=soccer&type=standings&league=bundesliga",
      "/api/other?sport=ncaa&type=scoreboard",
      "/api/other?sport=ncaa&type=rankings",
      "/api/other?sport=ncaa&ncaasport=football&type=scoreboard",
      "/api/other?sport=ncaa&gender=womens&type=scoreboard",
    ]
  });
}
