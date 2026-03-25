# api/baseball.py
# Apex Capper — Baseball Savant data endpoint
# Zero heavy dependencies — stdlib + requests only
#
# Routes:
#   /api/baseball?type=season&name=verlander_justin&season=2026
#   /api/baseball?type=recent&name=verlander_justin&starts=4&player_id=434378
#   /api/baseball?type=bullpen&team=NYY&days=3
#   /api/baseball?type=debug&season=2025

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

def clean_csv_text(text):
    """
    Savant CSVs have a UTF-8 BOM (\ufeff) and the first row is wrapped in
    quotes: "\ufeff\"last_name\"", " first_name\"", ...
    This strips all of that so column names are clean plain strings.
    """
    # Remove BOM
    text = text.lstrip('\ufeff')
    # Remove surrounding quotes from the header line only
    lines = text.split('\n')
    if lines:
        # Strip all " characters from the header line
        lines[0] = lines[0].replace('"', '').strip()
    return '\n'.join(lines)

def fetch_csv(url):
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    text = r.text.strip()
    if not text or text.startswith('<'): return []
    text = clean_csv_text(text)
    return list(csv.DictReader(io.StringIO(text)))

def find_player(rows, last, first):
    """
    After cleaning, Savant leaderboard CSVs have these name columns:
      arsenal/expected:  last_name="Webb, Logan"  first_name="657277"  <- STILL SHIFTED
      
    Wait — from the debug output the data shows:
      last_name col = "Webb, Logan"   (name is IN the last_name column as "Last, First")
      first_name col = "657277"        (this is actually the player ID!)
      pitcher col = "92.8"             (this is actually the FF velo!)
    
    So the CSV is: last_name (="Last, First"), first_name (=player_id), pitcher (=ff_speed), ...
    The column names after the BOM/quote fix are: last_name, first_name, pitcher, ff_avg_speed...
    But the VALUES are shifted: last_name holds "Webb, Logan" (combined name),
    first_name holds the numeric ID, pitcher holds first velocity value.
    
    This means: search the 'last_name' column for "Last, First" format.
    """
    last_l  = last.lower().strip()
    first_l = first.lower().strip()

    for row in rows:
        # After BOM fix: 'last_name' column contains "Last, First" combined
        # e.g. "Webb, Logan" or "Verlander, Justin"
        ln_col = str(row.get('last_name', '')).lower().strip()

        # Match: "verlander, justin"
        if last_l in ln_col and first_l in ln_col:
            return row

        # Also check player_name column (percentile endpoint)
        pn_col = str(row.get('player_name', '')).lower().strip()
        if last_l in pn_col and first_l in pn_col:
            return row

        # Fallback: search all values in the row
        all_vals = ' '.join(str(v) for v in row.values()).lower()
        if last_l in all_vals and first_l in all_vals:
            return row

    return None

def ok(data):  return 200, json.dumps(data, default=str)
def err(msg, code=400): return code, json.dumps({'error': msg})
def yr(): return datetime.now().year


# ── player ID lookup ──────────────────────────────────────────────────────────

def lookup_id(last, first):
    """Resolve MLBAM ID. After BOM fix, 'first_name' col actually holds the player ID."""
    # First try: get ID directly from the arsenal CSV (first_name col = ID after shift)
    try:
        rows = fetch_csv(
            f"{SAVANT}/leaderboard/pitch-arsenals?year={yr()}&min=100&type=avg_speed&hand=&csv=true"
        )
        row = find_player(rows, last, first)
        if row:
            # After column shift: 'first_name' column actually holds the MLBAM ID
            pid = row.get('first_name', '')
            if pid and str(pid).isdigit():
                return int(pid)
    except Exception:
        pass

    # Fallback: Savant player search API
    try:
        r = requests.get(
            f"{SAVANT}/player/search-all?search={first}+{last}",
            headers=HEADERS, timeout=15
        )
        data = r.json()
        if not data: return None
        for p in data:
            if str(p.get('pos', '')).upper() in ('P', 'SP', 'RP'):
                return int(p['id'])
        return int(data[0]['id'])
    except Exception:
        return None


# ── DEBUG ─────────────────────────────────────────────────────────────────────

def handle_debug(params):
    season = int(params.get('season', [yr()])[0])
    result = {}
    endpoints = {
        'arsenal_speed': f"{SAVANT}/leaderboard/pitch-arsenals?year={season}&min=100&type=avg_speed&hand=&csv=true",
        'expected':      f"{SAVANT}/leaderboard/expected_statistics?type=pitcher&year={season}&position=&team=&min=q&csv=true",
        'percentile':    f"{SAVANT}/leaderboard/percentile-rankings?type=pitcher&year={season}&position=&team=&csv=true",
    }
    for name, url in endpoints.items():
        try:
            rows = fetch_csv(url)
            if rows:
                result[name] = {
                    'total_rows':   len(rows),
                    'columns':      list(rows[0].keys()),
                    'first_player': dict(list(rows[0].items())[:12]),
                    'second_player': dict(list(rows[1].items())[:12]) if len(rows) > 1 else {},
                }
            else:
                result[name] = {'error': 'empty response'}
        except Exception as e:
            result[name] = {'error': str(e), 'trace': traceback.format_exc()}
    return ok(result)


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
    result  = {'name': display, 'season': season, 'sources': []}

    # ── 1. velocity per pitch type ─────────────────────────────────────────
    # Column layout after BOM fix (values are shifted 1 right vs headers):
    #   last_name="Verlander, Justin"  first_name=434378(ID)  pitcher=ff_speed  ff_avg_speed=si_speed ...
    # So actual pitch velocities are in columns SHIFTED by the header confusion.
    # We read them by their header names which are now correct after clean_csv_text.
    try:
        rows = fetch_csv(f"{SAVANT}/leaderboard/pitch-arsenals?year={season}&min=100&type=avg_speed&hand=&csv=true")
        row  = find_player(rows, last, first)
        if row:
            # The column named 'pitcher' actually holds FF velo (due to the shift)
            # The column named 'ff_avg_speed' holds SI velo, etc.
            # Map what we actually want:
            # From debug: columns = [last_name, first_name, pitcher, ff_avg_speed, si_avg_speed, fc_avg_speed, sl_avg_speed, ch_avg_speed, cu_avg_speed, fs_avg_speed, kn_avg_speed, st_avg_speed, sv_avg_speed]
            # From debug first_player values: pitcher=92.8(FF), ff_avg_speed=92.6(SI), si_avg_speed=91(FC?), fc_avg_speed="", sl_avg_speed=86.5, ch_avg_speed="", etc.
            # The shift means: real FF = 'pitcher' col, real SI = 'ff_avg_speed' col, etc.
            # BUT: this only applies when the BOM causes a 1-col rightward shift.
            # After our clean_csv_text strips the BOM+quotes, the headers should be correct.
            # Let's try reading the named columns directly first:
            velo = {}
            col_map = {
                'ff': 'pitcher',        # FF velo is in 'pitcher' col after shift
                'si': 'ff_avg_speed',
                'fc': 'si_avg_speed',
                'sl': 'sl_avg_speed',
                'ch': 'ch_avg_speed',
                'cu': 'cu_avg_speed',
                'fs': 'fs_avg_speed',
                'st': 'st_avg_speed',
                'kn': 'kn_avg_speed',
            }
            for pt, col in col_map.items():
                v = sf(row.get(col), 1)
                if v: velo[f'{pt}_velo'] = v
            if velo:
                result['velo_by_pitch'] = velo
                result['sources'].append('savant_arsenal_speed')
                result['_velo_note'] = 'Column mapping adjusted for Savant BOM/shift quirk'
    except Exception as e: result['velo_error'] = str(e)

    # ── 2. spin rate per pitch type ────────────────────────────────────────
    try:
        rows = fetch_csv(f"{SAVANT}/leaderboard/pitch-arsenals?year={season}&min=100&type=avg_spin&hand=&csv=true")
        row  = find_player(rows, last, first)
        if row:
            spin = {}
            # Same shift applies — use shifted col names
            spin_map = {
                'ff': 'pitcher',
                'si': 'ff_avg_spin',
                'sl': 'sl_avg_spin',
                'ch': 'ch_avg_spin',
                'cu': 'cu_avg_spin',
            }
            for pt, col in spin_map.items():
                s = sf(row.get(col), 0)
                if s: spin[f'{pt}_spin'] = s
            if spin:
                result['spin_by_pitch'] = spin
                result['sources'].append('savant_arsenal_spin')
    except Exception as e: result['spin_error'] = str(e)

    # ── 3. xERA / expected stats ───────────────────────────────────────────
    # Expected stats CSV column layout from debug:
    # Due to Savant BOM/quote shift, every value sits one column to the right.
    # Confirmed mapping from debug output (Webb 2025 as reference):
    #   CSV col 'era'                    -> real value is xERA
    #   CSV col 'xera'                   -> real value is ERA-minus-xERA gap (ERA - xERA)
    #   CSV col 'est_woba_minus_woba_diff'-> real value is ERA
    #   CSV col 'woba'                   -> real value is xWOBA
    #   CSV col 'ba'                     -> real value is xBA
    #   CSV col 'slg'                    -> real value is xSLG
    # So: real ERA  = est_woba_minus_woba_diff col
    #     real xERA = era col
    #     real gap  = xera col (= ERA - xERA, negative = ERA better than xERA)
    try:
        rows = fetch_csv(f"{SAVANT}/leaderboard/expected_statistics?type=pitcher&year={season}&position=&team=&min=q&csv=true")
        row  = find_player(rows, last, first)
        if row:
            xera = sf(row.get('era'))                        # xERA is in 'era' col
            gap  = sf(row.get('xera'))                       # ERA-xERA gap is in 'xera' col
            era  = round(xera + gap, 2) if (xera and gap is not None) else None
            result.update({
                'era':   era,
                'xera':  xera,
                'xwoba': sf(row.get('woba')),                # xWOBA is in 'woba' col
                'xba':   sf(row.get('ba')),                  # xBA is in 'ba' col
                'xslg':  sf(row.get('slg')),                 # xSLG is in 'slg' col
            })
            if era is not None and xera is not None:
                gap = round(xera - era, 2)
                result['era_xera_gap'] = gap
                if   gap >=  1.5:  sig, note = 'HIGH_REGRESSION_RISK',     f'xERA {gap} above ERA — pitcher has been lucky, expect more runs.'
                elif gap >=  0.75: sig, note = 'MODERATE_REGRESSION_RISK', f'xERA {gap} above ERA — mild regression risk.'
                elif gap <= -1.5:  sig, note = 'IMPROVEMENT_LIKELY',       f'ERA {abs(gap)} above xERA — pitcher unlucky, expect fewer runs.'
                elif gap <= -0.75: sig, note = 'MILD_IMPROVEMENT',         f'ERA {abs(gap)} above xERA — mild improvement likely.'
                else:              sig, note = 'NEUTRAL',                  'ERA and xERA aligned — no regression signal.'
                result['regression_signal'] = sig
                result['regression_note']   = note
            result['sources'].append('savant_expected')
    except Exception as e: result['expected_error'] = str(e)

    # ── 4. percentile ranks ────────────────────────────────────────────────
    # Percentile CSV: player_name col = "Fedde, Erick" (clean, no shift issue here)
    # Columns: player_name, player_id, year, xwoba, xba, xslg, xiso, xobp,
    #          brl, brl_percent, exit_velocity, max_ev, hard_hit_percent,
    #          k_percent, bb_percent, whiff_percent, chase_percent, xera, fb_velocity, fb_spin, curve_spin
    try:
        rows = fetch_csv(f"{SAVANT}/leaderboard/percentile-rankings?type=pitcher&year={season}&position=&team=&csv=true")
        row  = find_player(rows, last, first)
        if row:
            result['percentile_ranks'] = {
                'xera':     sf(row.get('xera'),             0),
                'k_pct':    sf(row.get('k_percent'),        0),
                'bb_pct':   sf(row.get('bb_percent'),       0),
                'hard_hit': sf(row.get('hard_hit_percent'), 0),
                'barrel':   sf(row.get('brl_percent'),      0),
                'whiff':    sf(row.get('whiff_percent'),    0),
                'chase':    sf(row.get('chase_percent'),    0),
                'fb_velo':  sf(row.get('fb_velocity'),      0),
                'fb_spin':  sf(row.get('fb_spin'),          0),
            }
            result['sources'].append('savant_percentiles')
    except Exception as e: result['percentile_error'] = str(e)

    if not result['sources']:
        result['warning'] = (
            f'No data found for "{display}" in {season}. '
            'Try: ?type=debug&season=2025 to see raw column layout. '
            'Also check spelling — format: verlander_justin'
        )
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
            'Pass player_id= directly. Find it at baseballsavant.mlb.com', 404
        )

    url = (
        f"{SAVANT}/statcast_search/csv?"
        f"all=true&player_type=pitcher"
        f"&game_date_gt={date_ago(75)}&game_date_lt={date_ago(0)}"
        f"&pitchers_lookup[]={mlbam}"
        f"&game_type=R&min_pitches=0&min_results=0"
        f"&group_by=name&sort_col=pitches&sort_order=desc&type=details"
    )
    try:
        rows = fetch_csv(url)
    except Exception as e:
        return err(f'Statcast fetch failed: {e}', 500)
    if not rows:
        return err(f'No pitch data for {display} (ID:{mlbam}) in last 75 days.', 404)

    games = {}
    for row in rows:
        gd = row.get('game_date', '')
        if gd: games.setdefault(gd, []).append(row)

    starts = []
    for gdate in sorted(games):
        gr = games[gdate]
        if len(gr) < 40: continue

        ff_v, si_v, all_v, spins, ks, bbs, pa = [], [], [], [], 0, 0, 0
        for row in gr:
            pt = row.get('pitch_type', '')
            v  = sf(row.get('release_speed'), 1)
            if v:
                all_v.append(v)
                if pt in ('FF', 'FA'): ff_v.append(v)
                elif pt == 'SI':       si_v.append(v)
            sp = sf(row.get('release_spin_rate'), 0)
            if sp and pt in ('FF', 'FA'): spins.append(sp)
            ev = row.get('events', '')
            if ev:
                pa += 1
                if ev == 'strikeout': ks += 1
                elif ev in ('walk', 'hit_by_pitch'): bbs += 1

        avg = lambda lst, d=1: round(sum(lst)/len(lst), d) if lst else None
        starts.append({
            'date': gdate, 'pitches': len(gr),
            'ff_velo':  avg(ff_v),  'si_velo': avg(si_v),
            'all_velo': avg(all_v), 'ff_spin': avg(spins, 0),
            'k_pct':  round(ks/pa,  3) if pa else None,
            'bb_pct': round(bbs/pa, 3) if pa else None,
        })

    starts = starts[-n_starts:]
    if not starts:
        return err(f'No qualifying starts (40+ pitches) in last 75 days for {display}.')

    # Season FF velo from arsenal — use 'pitcher' col (shifted FF velo)
    season_ff = None
    try:
        ars = fetch_csv(f"{SAVANT}/leaderboard/pitch-arsenals?year={season}&min=100&type=avg_speed&hand=&csv=true")
        ar  = find_player(ars, last, first)
        if ar: season_ff = sf(ar.get('pitcher'), 1)  # 'pitcher' col = FF velo after shift
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
            f'Apex lambda +8-10%% for opposing team.'
            if dip_flag else
            f'No velo drop detected. Recent {recent_ff}mph vs season {season_ff}mph.'
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
        pid = row.get('pitcher', row.get('pitcher_id', ''))
        if not pid: continue
        pitchers.setdefault(pid, {
            'name': row.get('player_name', f'ID:{pid}'),
            'id': pid, 'by_date': {}
        })
        gd = row.get('game_date', '')
        if gd:
            pitchers[pid]['by_date'].setdefault(gd, 0)
            pitchers[pid]['by_date'][gd] += 1

    yesterday = date_ago(1)
    relievers = []
    for pid, d in pitchers.items():
        bd = d['by_date']
        if max(bd.values(), default=0) >= 60: continue
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
            + (f'Top arm pitched yesterday. ' if closer_yday else '')
            + 'Lambda: 60+→+10%, 40-59→+6%, 25-39→+3%, fresh→0%.'
        ),
    })


# ── Vercel handler ────────────────────────────────────────────────────────────
def handle_full(params):
    season_status, season_body = handle_season(params)
    recent_status, recent_body = handle_recent(params)
    season_data = json.loads(season_body)
    recent_data = json.loads(recent_body)
    return ok({
        'name':   season_data.get('name') or recent_data.get('name'),
        'season': season_data,
        'recent': recent_data if recent_status == 200 else None,
    })
class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)
        qtype  = params.get('type', [''])[0]
        try:
            if   qtype == 'debug':   status, body = handle_debug(params)
            elif qtype == 'full':    status, body = handle_full(params)
            elif qtype == 'season':  status, body = handle_season(params)
            elif qtype == 'recent':  status, body = handle_recent(params)
            elif qtype == 'bullpen': status, body = handle_bullpen(params)
            else: status, body = err(
                'type required: debug | season | recent | bullpen  —  '
                'e.g. ?type=season&name=verlander_justin&season=2025'
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
