// ═══════════════════════════════════════════════════════════════
// APEX PICK GRADER (MLB + NFL)
// ═══════════════════════════════════════════════════════════════
// Vercel serverless function — runs via cron OR manual trigger.
//
// Pulls pending MLB + NFL picks from Supabase, finds the game (MLB Stats API
// for baseball, ESPN scoreboard for football), computes W/L/Push, writes the
// result back via service_role key.
//
// MLB: moneyline, total (O/U), F5 moneyline/total, player_prop (hits/TB/HR/RBI/K)
// NFL: moneyline, spread (with push), total, and 1st-half h1_moneyline/h1_spread/h1_total
// Skips: MLB run line; NFL player props (added later)
//
// Environment variables required (set in Vercel project settings):
//   SUPABASE_URL                — https://fmaxypsjsnknpbxplmuf.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   — service_role secret from Supabase API Keys
//   CRON_SECRET                 — random string for manual trigger auth
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;
const MLB_API      = 'https://statsapi.mlb.com/api/v1';

// ── HELPERS ────────────────────────────────────────────────

const stripAccents = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const norm = s => stripAccents(String(s || '')).toLowerCase().trim();

async function supaFetch(path, options = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.method === 'PATCH' ? 'return=minimal' : 'return=representation',
      ...(options.headers || {})
    }
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text().catch(()=>'')).slice(0,200)}`);
  return r.status === 204 ? null : r.json();
}

async function mlbFetch(path) {
  const r = await fetch(`${MLB_API}${path}`);
  if (!r.ok) throw new Error(`MLB API ${r.status} on ${path}`);
  return r.json();
}

// ── GAME LOOKUP ────────────────────────────────────────────

function parseMatchup(matchup) {
  if (!matchup || matchup === 'SLATE_TOP_PLAYS' || matchup === 'CHAT_QUERY') {
    return { away: null, home: null };
  }
  const m = matchup.match(/^(.+?)\s+@\s+(.+)$/);
  if (m) return { away: m[1].trim(), home: m[2].trim() };
  return { away: null, home: null };
}

// Try given date and +/-1 day to catch overnight pick edge cases
async function findGame(dateForLookup, awayName, homeName, pickText) {
  const baseDate = new Date(dateForLookup);
  for (const offset of [0, -1, 1]) {
    const d = new Date(baseDate.getTime() + offset * 86400000);
    const ds = d.toISOString().split('T')[0];
    let sched;
    try { sched = await mlbFetch(`/schedule?sportId=1&date=${ds}&hydrate=linescore`); }
    catch (e) { continue; }
    const games = sched?.dates?.[0]?.games || [];
    if (!games.length) continue;

    // Path 1: explicit away @ home match
    if (awayName && homeName) {
      const an = norm(awayName), hn = norm(homeName);
      const g = games.find(x =>
        norm(x.teams.away.team.name).includes(an) &&
        norm(x.teams.home.team.name).includes(hn)
      );
      if (g) return g;
      // Reversed (sometimes order swaps)
      const g2 = games.find(x =>
        norm(x.teams.away.team.name).includes(hn) &&
        norm(x.teams.home.team.name).includes(an)
      );
      if (g2) return g2;
    }

    // Path 2: parse from pick_text (SLATE_TOP_PLAYS picks)
    if (pickText) {
      const ptNorm = norm(pickText);
      const nickname = name => norm(name).split(' ').pop();
      const candidates = [];
      for (const g of games) {
        const aNick = nickname(g.teams.away.team.name);
        const hNick = nickname(g.teams.home.team.name);
        const aFull = norm(g.teams.away.team.name);
        const hFull = norm(g.teams.home.team.name);
        // Strong match: both team nicknames in pick text
        if (ptNorm.includes(aNick) && ptNorm.includes(hNick)) return g;
        // Strong match: full names in pick text
        if (ptNorm.includes(aFull) && ptNorm.includes(hFull)) return g;
        // Weak match: single team
        if (ptNorm.includes(aNick) || ptNorm.includes(hNick) ||
            ptNorm.includes(aFull) || ptNorm.includes(hFull)) {
          candidates.push(g);
        }
      }
      // Accept single-team match (typical for "Team ML" picks)
      if (candidates.length === 1) return candidates[0];
    }
  }
  return null;
}

// ── PLAYER LOOKUP ──────────────────────────────────────────

async function findPlayerInGame(playerName, game) {
  let box;
  try { box = await mlbFetch(`/game/${game.gamePk}/boxscore`); }
  catch (e) { return null; }
  const searchName = norm(playerName);
  for (const side of ['away', 'home']) {
    const players = box?.teams?.[side]?.players || {};
    for (const key in players) {
      const p = players[key];
      const fn = norm(p.person?.fullName || '');
      // Exact match, contains match, or last-name match
      if (fn === searchName ||
          fn.includes(searchName) ||
          searchName.includes(fn) ||
          fn.split(' ').pop() === searchName.split(' ').pop()) {
        return { side, ...p };
      }
    }
  }
  return null;
}

// ── GRADING LOGIC ──────────────────────────────────────────

function isGameFinal(game) {
  const code = game?.status?.statusCode;
  // F = Final, FR = Final Resumed, FT = Final Tiebreaker
  return code === 'F' || code === 'FR' || code === 'FT' || code === 'O';
}

function gameScoreDetail(game) {
  const ls = game.linescore;
  const a = ls?.teams?.away?.runs ?? '?';
  const h = ls?.teams?.home?.runs ?? '?';
  return `${game.teams.away.team.name} ${a} - ${game.teams.home.team.name} ${h}`;
}

// Is this a First-5-Innings pick? F5 is a core strategy market, so it must
// grade on innings 1–5, not the 9-inning final.
function isF5(pick) {
  const m = (pick.market || '').toLowerCase();
  if (m.startsWith('f5') || m.includes('first5') || m.includes('first_5')) return true;
  const t = (pick.pick_text || '').toLowerCase();
  return /\bf5\b|first 5|first five|1st 5|through 5/.test(t);
}

// Sum runs over the first N innings from the linescore innings array.
// Returns null if the game didn't complete N innings (rain-shortened), so the
// caller leaves the pick pending rather than grading on partial data.
function firstNRuns(game, n) {
  const innings = game.linescore?.innings;
  if (!Array.isArray(innings) || innings.length < n) return null;
  let a = 0, h = 0;
  for (let i = 0; i < n; i++) {
    a += innings[i]?.away?.runs ?? 0;
    h += innings[i]?.home?.runs ?? 0;
  }
  return { away: a, home: h };
}

// Robust team → side matcher. Handles shared-nickname collisions like
// Red Sox / White Sox, where a naive "last word" check mis-assigns the side.
function teamSide(pickedTeam, awayName, homeName) {
  const pn = norm(pickedTeam);
  const an = norm(awayName), hn = norm(homeName);
  // 1. Full-name containment, either direction — strongest signal.
  const awayFull = an.includes(pn) || pn.includes(an);
  const homeFull = hn.includes(pn) || pn.includes(hn);
  if (awayFull && !homeFull) return 'away';
  if (homeFull && !awayFull) return 'home';
  // 2. Nickname (last word) only when the two teams' nicknames differ.
  const anNick = an.split(' ').pop(), hnNick = hn.split(' ').pop();
  if (anNick !== hnNick) {
    const a = pn.includes(anNick), h = pn.includes(hnNick);
    if (a && !h) return 'away';
    if (h && !a) return 'home';
  } else {
    // Shared nickname (e.g. "sox"): decide on the distinguishing city/color word.
    const overlap = full => full.split(' ').filter(w => w && pn.includes(w)).length;
    const ao = overlap(an), ho = overlap(hn);
    if (ao > ho) return 'away';
    if (ho > ao) return 'home';
  }
  return null;
}

function gradeMoneyline(pick, game, innings = null) {
  if (!isGameFinal(game)) return { status: 'pending', reason: 'not_final' };
  let awayRuns, homeRuns;
  if (innings) {
    const r = firstNRuns(game, innings);
    if (!r) return { status: 'pending', reason: `f5_innings_incomplete` };
    awayRuns = r.away; homeRuns = r.home;
  } else {
    awayRuns = game.linescore?.teams?.away?.runs;
    homeRuns = game.linescore?.teams?.home?.runs;
  }
  if (awayRuns == null || homeRuns == null) return { status: 'pending', reason: 'no_score' };

  const pickedTeam = pick.pick_text.replace(/\s+(F5\s+)?ML\b.*$/i, '').replace(/\s+F5\b.*$/i, '').trim();
  const side = teamSide(pickedTeam, game.teams.away.team.name, game.teams.home.team.name);
  if (!side) return { status: 'error', reason: `could_not_match_team: ${pickedTeam}` };

  const pickedRuns = side === 'away' ? awayRuns : homeRuns;
  const oppRuns = side === 'away' ? homeRuns : awayRuns;
  const tag = innings ? `F5 ` : '';
  const detail = `${tag}${gameScoreDetail(game)}` + (innings ? ` [F5: ${awayRuns}-${homeRuns}]` : '');

  if (pickedRuns > oppRuns) return { result: 'W', final_detail: detail };
  if (pickedRuns < oppRuns) return { result: 'L', final_detail: detail };
  return { result: 'P', final_detail: detail + ' (tied)' };
}

function gradeTotal(pick, game, innings = null) {
  if (!isGameFinal(game)) return { status: 'pending', reason: 'not_final' };
  let aw, hr;
  if (innings) {
    const r = firstNRuns(game, innings);
    if (!r) return { status: 'pending', reason: `f5_innings_incomplete` };
    aw = r.away; hr = r.home;
  } else {
    aw = game.linescore?.teams?.away?.runs;
    hr = game.linescore?.teams?.home?.runs;
  }
  if (aw == null || hr == null) return { status: 'pending', reason: 'no_score' };
  const total = aw + hr;

  const line = parseFloat(pick.line);
  if (isNaN(line)) return { status: 'error', reason: 'no_line' };

  const pt = pick.pick_text.toLowerCase();
  const verdict = (pick.verdict || '').toUpperCase();
  const isOver  = pt.match(/\bover\b/) || verdict.includes('OVER');
  const isUnder = pt.match(/\bunder\b/) || verdict.includes('UNDER');

  const tag = innings ? 'F5 total runs' : 'Total runs';
  const detail = `${tag}: ${total} (line ${line}) — ${gameScoreDetail(game)}`;
  if (total === line) return { result: 'P', final_detail: detail };
  if (isOver)  return { result: total > line ? 'W' : 'L', final_detail: detail };
  if (isUnder) return { result: total < line ? 'W' : 'L', final_detail: detail };
  return { status: 'error', reason: 'no_direction_in_pick' };
}

async function gradePlayerProp(pick, game) {
  if (!isGameFinal(game)) return { status: 'pending', reason: 'not_final' };
  if (pick.verdict === 'PASS') {
    return { result: 'V', final_detail: 'Model recommended PASS (no action taken)' };
  }

  const player = await findPlayerInGame(pick.player_name, game);
  if (!player) return { status: 'error', reason: `player_not_found: ${pick.player_name}` };

  const stats = player.stats || {};
  const propType = (pick.prop_type || '').toLowerCase();
  let actual = 0, statSource = '';

  if (propType === 'hits' || (propType.includes('hit') && !propType.includes('home'))) {
    actual = stats.batting?.hits ?? 0;
    statSource = 'batting.hits';
  } else if (propType.includes('total base')) {
    actual = stats.batting?.totalBases ?? 0;
    statSource = 'batting.totalBases';
  } else if (propType.includes('home run')) {
    actual = stats.batting?.homeRuns ?? 0;
    statSource = 'batting.homeRuns';
  } else if (propType.includes('rbi') || propType.includes('run batted')) {
    actual = stats.batting?.rbi ?? 0;
    statSource = 'batting.rbi';
  } else if (propType.includes('strikeout') || propType === 'strikeouts') {
    // Pitcher prop if they pitched, else batter strikeouts
    if (stats.pitching && stats.pitching.inningsPitched && stats.pitching.inningsPitched !== '0.0') {
      actual = stats.pitching.strikeOuts ?? 0;
      statSource = 'pitching.strikeOuts';
    } else {
      actual = stats.batting?.strikeOuts ?? 0;
      statSource = 'batting.strikeOuts';
    }
  } else {
    return { status: 'error', reason: `unknown_prop_type: ${pick.prop_type}` };
  }

  const line = parseFloat(pick.line);
  if (isNaN(line)) return { status: 'error', reason: 'no_line' };

  const v = (pick.verdict || '').toUpperCase();
  const isOver  = v.includes('OVER');
  const isUnder = v.includes('UNDER');
  const detail = `${pick.player_name}: ${actual} ${statSource.split('.')[1]} (line ${line})`;

  if (actual === line) return { result: 'P', final_detail: detail };
  if (isOver)  return { result: actual > line ? 'W' : 'L', final_detail: detail };
  if (isUnder) return { result: actual < line ? 'W' : 'L', final_detail: detail };
  return { status: 'error', reason: `no_direction in verdict: ${v}` };
}

// ═══════════════════════════════════════════════════════════
// NFL GRADING — ESPN box score (final + per-quarter), moneyline,
// spread (with push), total, and 1st-half (h1_*) markets.
// ═══════════════════════════════════════════════════════════
async function espnJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'ApexGrader/1.0', 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}
function espnDateStr(d) { return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`; }
async function findNflGame(dateForLookup, away, home) {
  const base = new Date(dateForLookup);
  const wantA = norm(away), wantH = norm(home);
  if (!wantA || !wantH) return null;
  for (const off of [0, -1, 1, -2]) {
    const d = new Date(base.getTime() + off * 86400000);
    let sb;
    try { sb = await espnJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${espnDateStr(d)}`); }
    catch (e) { continue; }
    const ev = (sb.events || []).find(e => {
      const comp = e.competitions?.[0];
      const names = (comp?.competitors || []).map(c => norm(c.team?.displayName) + ' ' + norm(c.team?.shortDisplayName)).join(' ');
      return [wantA, wantH].every(w => names.includes(w));
    });
    if (ev) return ev;
  }
  return null;
}
function nflScore(ev) {
  const comp = ev.competitions?.[0]; const cs = comp?.competitors || [];
  const H = cs.find(c => c.homeAway === 'home'), A = cs.find(c => c.homeAway === 'away');
  if (!H || !A) return null;
  const q = c => (c.linescores || []).map(x => parseFloat(x.value) || 0);
  return {
    completed: ev.status?.type?.completed === true,
    homeName: H.team?.displayName, awayName: A.team?.displayName,
    home: parseFloat(H.score), away: parseFloat(A.score), homeQ: q(H), awayQ: q(A)
  };
}
function nflHalf(s, n) { let a = 0, h = 0; for (let i = 0; i < n; i++) { a += s.awayQ[i] || 0; h += s.homeQ[i] || 0; } return { away: a, home: h }; }
function gradeNflMoneyline(pick, s, half) {
  let a = s.away, h = s.home; if (half) { const r = nflHalf(s, 2); a = r.away; h = r.home; }
  const side = teamSide(pick.pick_text.replace(/\b(1H|H1|first half)\b/ig, '').replace(/\s+ML\b.*$/i, '').trim(), s.awayName, s.homeName);
  if (!side) return { status: 'error', reason: `could_not_match_team: ${pick.pick_text}` };
  const my = side === 'away' ? a : h, opp = side === 'away' ? h : a;
  const detail = `${half ? '1H ' : ''}${s.awayName} ${s.away} - ${s.homeName} ${s.home}${half ? ` [1H ${a}-${h}]` : ''}`;
  if (my > opp) return { result: 'W', final_detail: detail };
  if (my < opp) return { result: 'L', final_detail: detail };
  return { result: 'P', final_detail: detail + ' (tie)' };
}
function gradeNflSpread(pick, s, half) {
  let a = s.away, h = s.home; if (half) { const r = nflHalf(s, 2); a = r.away; h = r.home; }
  const line = parseFloat(pick.line); if (isNaN(line)) return { status: 'error', reason: 'no_line' };
  const cleaned = pick.pick_text.replace(/[-+]?\d+(\.\d+)?/g, '').replace(/\b(1H|H1|first half|spread|ats|cover)\b/ig, '').trim();
  const side = teamSide(cleaned, s.awayName, s.homeName);
  if (!side) return { status: 'error', reason: `could_not_match_team: ${pick.pick_text}` };
  const margin = side === 'home' ? h - a : a - h;   // picked team's margin
  const diff = margin + line;                        // line is the picked side's spread (e.g. -7.5)
  const detail = `${half ? '1H ' : ''}${s.awayName} ${s.away} - ${s.homeName} ${s.home} · ${pick.pick_text} (margin ${margin >= 0 ? '+' : ''}${margin}, line ${line})`;
  if (Math.abs(diff) < 1e-9) return { result: 'P', final_detail: detail + ' (push)' };
  return { result: diff > 0 ? 'W' : 'L', final_detail: detail };
}
function gradeNflTotal(pick, s, half) {
  let a = s.away, h = s.home; if (half) { const r = nflHalf(s, 2); a = r.away; h = r.home; }
  const total = a + h; const line = parseFloat(pick.line); if (isNaN(line)) return { status: 'error', reason: 'no_line' };
  const t = (pick.pick_text || '').toLowerCase(), v = (pick.verdict || '').toLowerCase();
  const isOver = /\bover\b/.test(t) || v.includes('over'), isUnder = /\bunder\b/.test(t) || v.includes('under');
  const detail = `${half ? '1H total' : 'Total'}: ${total} (line ${line}) — ${s.awayName} ${s.away}, ${s.homeName} ${s.home}`;
  if (total === line) return { result: 'P', final_detail: detail };
  if (isOver) return { result: total > line ? 'W' : 'L', final_detail: detail };
  if (isUnder) return { result: total < line ? 'W' : 'L', final_detail: detail };
  return { status: 'error', reason: 'no_direction_in_pick' };
}
async function gradeNflPick(pick) {
  const { away, home } = parseMatchup(pick.matchup);
  const ev = await findNflGame(pick.game_start_at || pick.created_at, away, home);
  if (!ev) return { status: 'no_game_found', pick_id: pick.id, pick_text: pick.pick_text };
  const s = nflScore(ev);
  if (!s || !s.completed) return { status: 'game_not_final', pick_id: pick.id };
  const mkt = (pick.market || '').toLowerCase();
  let result;
  if (mkt === 'h1_total')          result = gradeNflTotal(pick, s, true);
  else if (mkt === 'h1_spread')    result = gradeNflSpread(pick, s, true);
  else if (mkt === 'h1_moneyline') result = gradeNflMoneyline(pick, s, true);
  else if (mkt === 'total')        result = gradeNflTotal(pick, s, false);
  else if (mkt === 'spread')       result = gradeNflSpread(pick, s, false);
  else if (mkt === 'moneyline')    result = gradeNflMoneyline(pick, s, false);
  else if (mkt === 'prop' || mkt === 'player_prop') result = { status: 'unsupported', reason: 'nfl_prop_grading_not_implemented' };
  else result = { status: 'unsupported', reason: `unknown_market: ${pick.market}` };
  if (result.result) {
    await supaFetch(`/picks?id=eq.${pick.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ result: result.result, final_detail: result.final_detail, graded_at: new Date().toISOString() })
    });
    return { status: 'graded', pick_id: pick.id, result: result.result, detail: result.final_detail };
  }
  return { status: result.status || 'error', pick_id: pick.id, reason: result.reason };
}

// ── PIPELINE ───────────────────────────────────────────────

async function gradePick(pick) {
  const { away, home } = parseMatchup(pick.matchup);
  const dateForLookup = pick.game_start_at || pick.created_at;
  const game = await findGame(dateForLookup, away, home, pick.pick_text);

  if (!game) return { status: 'no_game_found', pick_id: pick.id, pick_text: pick.pick_text };
  if (!isGameFinal(game)) {
    return { status: 'game_not_final', pick_id: pick.id, gameStatus: game.status?.detailedState };
  }

  let result;
  const mkt = (pick.market || '').toLowerCase();
  const f5 = isF5(pick);
  if (mkt === 'f5_total' || (f5 && mkt === 'total'))          result = gradeTotal(pick, game, 5);
  else if (mkt === 'f5_moneyline' || (f5 && mkt === 'moneyline')) result = gradeMoneyline(pick, game, 5);
  else if (mkt === 'moneyline')          result = gradeMoneyline(pick, game);
  else if (mkt === 'total')              result = gradeTotal(pick, game);
  else if (mkt === 'player_prop')        result = await gradePlayerProp(pick, game);
  else if (mkt === 'spread')             result = { status: 'unsupported', reason: 'spread_not_implemented_yet' };
  else result = { status: 'unsupported', reason: `unknown_market: ${pick.market}` };

  if (result.result) {
    await supaFetch(`/picks?id=eq.${pick.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        result: result.result,
        final_detail: result.final_detail,
        graded_at: new Date().toISOString()
      })
    });
    return { status: 'graded', pick_id: pick.id, result: result.result, detail: result.final_detail };
  }
  return { status: result.status || 'error', pick_id: pick.id, reason: result.reason };
}

// ── HTTP HANDLER ───────────────────────────────────────────

export default async function handler(req, res) {
  // CORS for manual testing
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth: Vercel cron header OR manual Bearer token
  const auth = req.headers.authorization || '';
  const isCron = req.headers['x-vercel-cron'] === '1' || auth === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron) return res.status(401).json({ error: 'unauthorized' });

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'missing_env_vars', need: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] });
  }

  const dryRun = req.query?.dry_run === 'true' || req.query?.dry === '1';
  const limit  = parseInt(req.query?.limit) || 50;

  try {
    // Pull pending MLB + NFL picks older than 4 hours (game safely over)
    const cutoff = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    const picks = await supaFetch(
      `/picks?select=*&sport=in.(MLB,NFL)&result=is.null&created_at=lt.${cutoff}&order=created_at.asc&limit=${limit}`
    );

    if (!picks?.length) {
      return res.status(200).json({ message: 'No pending picks to grade', graded: 0 });
    }

    const summary = {
      total_pending: picks.length,
      graded: 0,
      W: 0, L: 0, P: 0, V: 0,
      still_pending: 0,
      no_game_found: 0,
      errors: [],
      details: []
    };

    for (const pick of picks) {
      try {
        if (dryRun) {
          summary.details.push({ id: pick.id, pick: pick.pick_text, market: pick.market, would_grade: true });
          continue;
        }
        const r = (pick.sport === 'NFL') ? await gradeNflPick(pick) : await gradePick(pick);
        summary.details.push(r);
        if (r.status === 'graded') {
          summary.graded++;
          summary[r.result] = (summary[r.result] || 0) + 1;
        } else if (r.status === 'game_not_final') summary.still_pending++;
        else if (r.status === 'no_game_found') summary.no_game_found++;
        else summary.errors.push(r);
      } catch (e) {
        summary.errors.push({ pick_id: pick.id, error: e.message });
      }
    }
    return res.status(200).json(summary);
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0,5) });
  }
}
