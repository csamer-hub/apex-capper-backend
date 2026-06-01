// ═══════════════════════════════════════════════════════════════
// APEX MLB PICK GRADER
// ═══════════════════════════════════════════════════════════════
// Vercel serverless function — runs via cron OR manual trigger.
//
// Pulls pending MLB picks from Supabase, finds the game on MLB Stats API,
// computes W/L/Push, writes result back via service_role key.
//
// Supports: moneyline, total (O/U), player_prop (hits/total bases/HR/K)
// Skips:    spread (MLB run line) — added later
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

function gradeMoneyline(pick, game) {
  if (!isGameFinal(game)) return { status: 'pending', reason: 'not_final' };
  const awayRuns = game.linescore?.teams?.away?.runs;
  const homeRuns = game.linescore?.teams?.home?.runs;
  if (awayRuns == null || homeRuns == null) return { status: 'pending', reason: 'no_score' };

  const pickedTeam = pick.pick_text.replace(/\s+ML\b.*$/i, '').trim();
  const pn = norm(pickedTeam);
  const an = norm(game.teams.away.team.name);
  const hn = norm(game.teams.home.team.name);

  let side = null;
  if (an.includes(pn) || pn.includes(an.split(' ').pop())) side = 'away';
  else if (hn.includes(pn) || pn.includes(hn.split(' ').pop())) side = 'home';
  if (!side) return { status: 'error', reason: `could_not_match_team: ${pickedTeam}` };

  const pickedRuns = side === 'away' ? awayRuns : homeRuns;
  const oppRuns = side === 'away' ? homeRuns : awayRuns;
  const detail = gameScoreDetail(game);

  if (pickedRuns > oppRuns) return { result: 'W', final_detail: detail };
  if (pickedRuns < oppRuns) return { result: 'L', final_detail: detail };
  return { result: 'P', final_detail: detail + ' (tied)' };
}

function gradeTotal(pick, game) {
  if (!isGameFinal(game)) return { status: 'pending', reason: 'not_final' };
  const aw = game.linescore?.teams?.away?.runs;
  const hr = game.linescore?.teams?.home?.runs;
  if (aw == null || hr == null) return { status: 'pending', reason: 'no_score' };
  const total = aw + hr;

  const line = parseFloat(pick.line);
  if (isNaN(line)) return { status: 'error', reason: 'no_line' };

  const pt = pick.pick_text.toLowerCase();
  const verdict = (pick.verdict || '').toUpperCase();
  const isOver  = pt.match(/\bover\b/) || verdict.includes('OVER');
  const isUnder = pt.match(/\bunder\b/) || verdict.includes('UNDER');

  const detail = `Total runs: ${total} (line ${line}) — ${gameScoreDetail(game)}`;
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
  if (pick.market === 'moneyline')       result = gradeMoneyline(pick, game);
  else if (pick.market === 'total')      result = gradeTotal(pick, game);
  else if (pick.market === 'player_prop') result = await gradePlayerProp(pick, game);
  else if (pick.market === 'spread')     result = { status: 'unsupported', reason: 'spread_not_implemented_yet' };
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

module.exports = async (req, res) => {
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
    // Pull pending MLB picks older than 4 hours (game safely over)
    const cutoff = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    const picks = await supaFetch(
      `/picks?select=*&sport=eq.MLB&result=is.null&created_at=lt.${cutoff}&order=created_at.asc&limit=${limit}`
    );

    if (!picks?.length) {
      return res.status(200).json({ message: 'No pending MLB picks to grade', graded: 0 });
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
        const r = await gradePick(pick);
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
};
