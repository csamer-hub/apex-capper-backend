# api/baseball.py
# Apex Capper — Baseball Savant data endpoint
# Zero heavy dependencies — uses only stdlib + requests
# Hits Baseball Savant CSV endpoints directly (same data pybaseball uses)
#
# Routes:
#   /api/baseball?type=season&name=verlander_justin&season=2026
#   /api/baseball?type=recent&name=verlander_justin&starts=4&player_id=434378
#   /api/baseball?type=bullpen&team=NYY&days=3

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from datetime import datetime, timedelta
import json, csv, io, math, traceback
import requests

SAVANT  = "https://baseballsavant.mlb.com"
HEADERS = {"User-Agent": "Mozilla/5.0 (ApexCapper/1.0)"}


# ── utilities ────────────────────────────────────────────────────────────────

def sf(val, decimals=2):
    try:
        if val in (None, '', 'null', 'NA', 'NaN'): return None
        f = float(val)
        return None if math.isnan(f) else round(f, decimals)
    except Exception: return None

def date_ago(days=0):
    return (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')

def fetch_csv(url):
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    text = r.text.strip()
    if not text or text.startswith('<'): return []
    return list(csv.DictReader(io.StringIO(text)))

def find_player(rows, name_keys, search):
    s = search.lower().strip()
    parts = s.split()
    for row in rows:
        for key in name_keys:
            cell = str(row.get(key, '')).lower()
            if s in cell or all(p in cell for p in parts):
                return row
    return None

def ok(data):  return 200, json.dumps(data, default=str)
def err(msg, code=400): return code, json.dumps({'error': msg})
def yr(): return datetime.now().year


# ── player ID lookup ──────────────────────────────────────────────────────────

def lookup_id(last, first):
    try:
        r = requests.get(
            f"{SAVANT}/player/search-all?search={first}+{last}",
            headers=HEADERS, timeout=15
        )
        data = r.json()
        if not data: return None
        for p in data:
            if str(p.get('pos','')).upper() in ('P','SP','RP'):
                return int(p['id'])
        return int(data[0]['id'])
    except Exception: return None


# ── SEASON sabermetrics ───────────────────────────────────────────────────────

def handle_season(params):
    name   = params.get('name',   [''])[0].strip()
    season = int(params.get('season', [yr()])[0])
    if not name:
        return err('name required — format: last_first  e.g. verlander_justin')

    parts   = name.lower().split('_')
    last    = parts[0] if len(parts) > 0 else ''
    first   = parts[1] if len(parts) > 1 else ''
    display = f"{first.title()} {last.title()}"
    nkeys   = ['player_name', 'last_name, first_name', 'name']
    lf      = f"{last}, {first}"
    result  = {'name': display, 'season': season, 'sources': []}

    # velocity per pitch type
    try:
        rows = fetch_csv(f"{SAVANT}/leaderboard/pitch-arsenals?year={season}&min=100&type=avg_speed&hand=&csv=true")
        row  = find_player(rows, nkeys, display) or find_player(rows, nkeys, lf)
        if row:
            velo = {}
            for pt in ['ff','si','sl','ch','cu','fc','fs','kc','st']:
                v = sf(row.get(f'{pt}_avg_speed'), 1)
                if v: velo[f'{pt}_velo'] = v
            result['velo_by_pitch'] = velo
            result['sources'].append('savant_arsenal_speed')
    except Exception as e: result['velo_error'] = str(e)

    # spin rate per pitch type
    try:
        rows = fetch_csv(f"{SAVANT}/leaderboard/pitch-arsenals?year={season}&min=100&type=avg_spin&hand=&csv=true")
        row  = find_player(rows, nkeys, display) or find_player(rows, nkeys, lf)
        if row:
            spin = {}
            for pt in ['ff','si','sl','ch','cu','fc']:
                s = sf(row.get(f'{pt}_avg_spin'), 0)
                if s: spin[f'{pt}_spin'] = s
            result['spin_by_pitch'] = spin
            result['sources'].append('savant_arsenal_spin')
    except Exception as e: result['spin_error'] = str(e)

    # xERA / expected stats
    try:
        rows = fetch_csv(f"{SAVANT}/leaderboard/expected_statistics?type=pitcher&year={season}&position=&team=&min=q&csv=true")
        row  = find_player(rows, nkeys, display) or find_player(rows, nkeys, lf)
        if row:
            era  = sf(row.get('era'))
            xera = sf(row.get('xera'))
            result.update({
                'era': era, 'xera': xera,
                'xwoba': sf(row.get('xwoba')),
                'xba':   sf(row.get('xba')),
                'pa':    sf(row.get('pa'), 0),
            })
            if era is not None and xera is not None:
                gap = round(xera - era, 2)
                result['era_xera_gap'] = gap
                if   gap >=  1.5: sig, note = 'HIGH_REGRESSION_RISK',    f'xERA {gap} above ERA — pitcher has been lucky, expect more runs allowed.'
                elif gap >=  0.75: sig, note = 'MODERATE_REGRESSION_RISK', f'xERA {gap} above ERA — mild regression risk.'
                elif gap <= -1.5: sig, note = 'IMPROVEMENT_LIKELY',       f'ERA {abs(gap)} above xERA — pitcher unlucky, expect fewer runs allowed.'
                elif gap <= -0.75: sig, note = 'MILD_IMPROVEMENT',         f'ERA {abs(gap)} above xERA — mild improvement likely.'
                else:              sig, note = 'NEUTRAL',                  'ERA and xERA aligned — no regression signal.'
                result['regression_signal'] = sig
                result['regression_note']   = note
            result['sources'].append('savant_expected')
    except Exception as e: result['expected_error'] = str(e)

    # percentile ranks
    try:
        rows = fetch_csv(f"{SAVANT}/leaderboard/percentile-rankings?type=pitcher&year={season}&position=&team=&csv=true")
        row  = find_player(rows, nkeys, display) or find_player(rows, nkeys, lf)
        if row:
            result['percentile_ranks'] = {
                'xera':     sf(row.get('xera'),             0),
                'k_pct':    sf(row.get('k_percent'),        0),
                'bb_pct':   sf(row.get('bb_percent'),       0),
                'hard_hit': sf(row.get('hard_hit_percent'), 0),
                'barrel':   sf(row.get('brl_percent'),      0),
                'whiff':    sf(row.get('whiff_percent'),    0),
                'chase':    sf(row.get('oz_swing_percent'), 0),
            }
            result['sources'].append('savant_percentiles')
    except Exception as e: result['percentile_error'] = str(e)

    if not result['sources']:
        result['warning'] = f'No data found for "{display}" in {season}. Check spelling — format: verlander_justin'
    return ok(result)


# ── RECENT FORM + velocity trend ──────────────────────────────────────────────

def handle_recent(params):
    name          = params.get('name',      [''])[0].strip()
    n_starts      = int(params.get('starts',    [4])[0])
    player_id_raw = params.get('player_id', [None])[0]
    season        = int(params.get('season', [yr()])[0])

    parts   = name.lower().split('_')
    last    = parts[0] if len(parts) > 0 else ''
    first   = parts[1] if len(parts) > 1 else ''
    display = f"{first.title()} {last.title()}"

    mlbam = int(player_id_raw) if player_id_raw else lookup_id(last, first)
    if not mlbam:
        return err(
            f'Could not resolve player ID for "{display}". '
            'Pass player_id directly — find it at baseballsavant.mlb.com', 404
        )

    url = (
        f"{SAVANT}/statcast_search/csv?"
        f"all=true&player_type=pitcher"
        f"&game_date_gt={date_ago(75)}&game_date_lt={date_ago(0)}"
        f"&pitchers_lookup[]={mlbam}"
        f"&game_type=R&min_pitches=0&min_results=0"
        f"&group_by=name&sort_col=pitches&sort_order=desc&type=details"
    )
    try:    rows = fetch_csv(url)
    except Exception as e: return err(f'Statcast fetch failed: {e}', 500)
    if not rows:
        return err(f'No pitch data for {display} (ID: {mlbam}) in last 75 days.', 404)

    # group by game date
    games = {}
    for row in rows:
        gd = row.get('game_date','')
        if gd: games.setdefault(gd, []).append(row)

    starts = []
    for gdate in sorted(games):
        gr = games[gdate]
        if len(gr) < 40: continue   # skip relief appearances

        ff_v, si_v, all_v, spins, ks, bbs, pa = [], [], [], [], 0, 0, 0
        for row in gr:
            pt = row.get('pitch_type','')
            v  = sf(row.get('release_speed'), 1)
            if v:
                all_v.append(v)
                if pt in ('FF','FA'): ff_v.append(v)
                elif pt == 'SI':      si_v.append(v)
            sp = sf(row.get('release_spin_rate'), 0)
            if sp and pt in ('FF','FA'): spins.append(sp)
            ev = row.get('events','')
            if ev:
                pa += 1
                if ev == 'strikeout': ks += 1
                elif ev in ('walk','hit_by_pitch'): bbs += 1

        avg = lambda lst, d=1: round(sum(lst)/len(lst), d) if lst else None
        starts.append({
            'date': gdate, 'pitches': len(gr),
            'ff_velo':  avg(ff_v),  'si_velo': avg(si_v),
            'all_velo': avg(all_v), 'ff_spin': avg(spins, 0),
            'k_pct':  round(ks/pa, 3) if pa else None,
            'bb_pct': round(bbs/pa,3) if pa else None,
        })

    starts = starts[-n_starts:]
    if not starts:
        return err(f'No qualifying starts (40+ pitches) found in last 75 days for {display}.')

    # season FF velo for comparison
    season_ff = None
    try:
        ars = fetch_csv(f"{SAVANT}/leaderboard/pitch-arsenals?year={season}&min=100&type=avg_speed&hand=&csv=true")
        nk  = ['player_name','last_name, first_name']
        ar  = find_player(ars, nk, display) or find_player(ars, nk, f"{last}, {first}")
        if ar: season_ff = sf(ar.get('ff_avg_speed'), 1)
    except Exception: pass

    ff_list   = [s['ff_velo'] for s in starts if s['ff_velo']]
    recent_ff = round(sum(ff_list)/len(ff_list), 1) if ff_list else None
    dip       = round(recent_ff - season_ff, 1) if (recent_ff and season_ff) else None
    dip_flag  = dip is not None and dip <= -0.8

    kl  = [s['k_pct']  for s in starts if s['k_pct']  is not None]
    bbl = [s['bb_pct'] for s in starts if s['bb_pct'] is not None]

    return ok({
        'name': display, 'player_id': mlbam,
        'starts_analyzed': len(starts),
        'date_range': f"{starts[0]['date']} to {starts[-1]['date']}",
        'starts': starts,
        'season_ff_velo': season_ff, 'recent_ff_velo': recent_ff,
        'recent_k_pct':  round(sum(kl) /len(kl),  3) if kl  else None,
        'recent_bb_pct': round(sum(bbl)/len(bbl), 3) if bbl else None,
        'velo_dip': dip, 'velo_dip_flag': dip_flag,
        'velo_dip_note': (
            f'FATIGUE/INJURY SIGNAL: FF down {abs(dip)}mph '
            f'({recent_ff}mph recent vs {season_ff}mph season). '
            f'Apex lambda boost +8-10%% for opposing team.'
            if dip_flag else
            f'No meaningful velo drop. Recent {recent_ff}mph vs season {season_ff}mph.'
        ),
        'apex_pitching_inputs': {'veloDipFlag': dip_flag, 'veloDipAmount': dip},
    })


# ── BULLPEN USAGE ─────────────────────────────────────────────────────────────

def handle_bullpen(params):
    team = params.get('team', [''])[0].strip().upper()
    days = int(params.get('days', [3])[0])
    if not team:
        return err('team required — 3-letter MLB abbreviation e.g. NYY, LAD, HOU')

    url = (
        f"{SAVANT}/statcast_search/csv?"
        f"all=true&player_type=pitcher"
        f"&game_date_gt={date_ago(days)}&game_date_lt={date_ago(0)}"
        f"&team={team}&game_type=R"
        f"&min_pitches=0&min_results=0"
        f"&group_by=name&sort_col=pitches&sort_order=desc&type=details"
    )
    try:    rows = fetch_csv(url)
    except Exception as e: return err(f'Statcast fetch failed: {e}', 500)
    if not rows:
        return err(f'No data for {team} in last {days} days. Check abbreviation or try days=5.')

    pitchers = {}
    for row in rows:
        pid = row.get('pitcher', row.get('pitcher_id',''))
        if not pid: continue
        pitchers.setdefault(pid, {
            'name': row.get('player_name', f'ID:{pid}'),
            'id': pid, 'by_date': {}
        })
        gd = row.get('game_date','')
        if gd:
            pitchers[pid]['by_date'].setdefault(gd, 0)
            pitchers[pid]['by_date'][gd] += 1

    yesterday  = date_ago(1)
    relievers  = []
    for pid, d in pitchers.items():
        bd = d['by_date']
        if max(bd.values(), default=0) >= 60: continue   # starter
        relievers.append({
            'name':              d['name'],
            'player_id':         pid,
            'total_pitches':     int(sum(bd.values())),
            'days_appeared':     int(len(bd)),
            'pitched_yesterday': bool(yesterday in bd),
            'pitches_by_date':   bd,
        })

    relievers.sort(key=lambda x: x['total_pitches'], reverse=True)
    top2         = relievers[:2]
    top2_pitches = sum(r['total_pitches'] for r in top2)
    closer_yday  = any(r['pitched_yesterday'] and r['total_pitches'] >= 15 for r in top2)
    fatigue      = 'HEAVY' if top2_pitches>=60 else 'MODERATE' if top2_pitches>=40 else 'MILD' if top2_pitches>=25 else 'FRESH'

    return ok({
        'team': team, 'days_analyzed': days,
        'date_range': f'{date_ago(days)} to {date_ago(0)}',
        'total_relievers': len(relievers),
        'relievers': relievers,
        'apex_bullpen_inputs': {
            'closerPitchedYesterday': closer_yday,
            'topTwoRelieverPitches':  int(top2_pitches),
        },
        'fatigue_level': fatigue,
        'fatigue_note': (
            f'Top-2 relievers threw {top2_pitches} combined pitches in last {days} days. '
            + (f'Top arm pitched yesterday — likely limited. ' if closer_yday else '')
            + 'Lambda: 60+→+10%, 40-59→+6%, 25-39→+3%, fresh→0%.'
        ),
    })


# ── Vercel handler ────────────────────────────────────────────────────────────

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)
        qtype  = params.get('type', [''])[0]
        try:
            if   qtype == 'season':  status, body = handle_season(params)
            elif qtype == 'recent':  status, body = handle_recent(params)
            elif qtype == 'bullpen': status, body = handle_bullpen(params)
            else: status, body = err(
                'type required: season | recent | bullpen  —  '
                'e.g. ?type=season&name=verlander_justin&season=2026'
            )
        except Exception as e:
            status, body = err(f'Server error: {e} — {traceback.format_exc()}', 500)

        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.end_headers()
        self.wfile.write(body.encode('utf-8'))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.end_headers()

    def log_message(self, format, *args): pass
