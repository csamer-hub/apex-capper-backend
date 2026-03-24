# api/baseball.py
# Apex Capper — pybaseball data endpoint
# Provides: SP sabermetrics, velocity trends, bullpen usage
# Routes:
#   /api/baseball?type=season&name=verlander_justin&season=2026
#   /api/baseball?type=recent&name=verlander_justin&starts=4
#   /api/baseball?type=bullpen&team=NYY&days=3

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
import traceback
from datetime import datetime, timedelta
import math

# ── pybaseball imports ──────────────────────────────────────────────────────
try:
    from pybaseball import (
        statcast_pitcher,
        statcast_pitcher_pitch_arsenal,
        statcast_pitcher_expected_stats,
        statcast_pitcher_percentile_ranks,
        pitching_stats,
        playerid_lookup,
        statcast,
        cache,
    )
    import pandas as pd
    cache.enable()
    PYBASEBALL_OK = True
    IMPORT_ERROR  = None
except Exception as _ie:
    PYBASEBALL_OK = False
    IMPORT_ERROR  = str(_ie)


# ── utility helpers ─────────────────────────────────────────────────────────

def safe_float(val, decimals=2):
    """Convert to float; return None on NaN/None/error."""
    try:
        f = float(val)
        return None if math.isnan(f) else round(f, decimals)
    except Exception:
        return None

def date_str(days_ago=0):
    """YYYY-MM-DD string for N days ago."""
    return (datetime.now() - timedelta(days=days_ago)).strftime('%Y-%m-%d')

def find_row(df, col, search):
    """Case-insensitive partial-name match across a DataFrame column."""
    s = search.lower().strip()
    for _, row in df.iterrows():
        cell = str(row.get(col, '')).lower()
        if s in cell or all(p in cell for p in s.split()):
            return row
    return None

def resolve_id(last, first):
    """Return MLBAM player ID or None."""
    try:
        df = playerid_lookup(last, first)
        if df is None or df.empty:
            return None
        df = df.sort_values('mlb_played_last', ascending=False)
        return int(df.iloc[0]['key_mlbam'])
    except Exception:
        return None

def ok(data):
    return 200, json.dumps(data, default=str)

def err(msg, code=400):
    return code, json.dumps({'error': msg})


# ── SEASON SABERMETRICS ─────────────────────────────────────────────────────
# GET /api/baseball?type=season&name=verlander_justin&season=2026
#
# Returns FIP, xFIP, SIERA, K%, BB%, Stuff+, velocity per pitch type,
# ERA-FIP gap (regression risk signal), xERA, percentile ranks.

def handle_season(params):
    name   = params.get('name',   [''])[0]
    season = int(params.get('season', [datetime.now().year])[0])

    if not name:
        return err('name required — format: last_first  e.g. verlander_justin')

    parts   = name.lower().split('_')
    last    = parts[0] if len(parts) > 0 else ''
    first   = parts[1] if len(parts) > 1 else ''
    display = f"{first.title()} {last.title()}"

    result = {'name': display, 'season': season, 'sources': []}

    # ── FanGraphs: FIP / xFIP / SIERA / Stuff+ / K% / BB% ──────────────────
    try:
        df_fg = pitching_stats(season, season, qual=1)
        row   = find_row(df_fg, 'Name', display)
        if row is not None:
            result.update({
                'era':           safe_float(row.get('ERA')),
                'fip':           safe_float(row.get('FIP')),
                'xfip':          safe_float(row.get('xFIP')),
                'siera':         safe_float(row.get('SIERA')),
                'k_pct':         safe_float(row.get('K%')),
                'bb_pct':        safe_float(row.get('BB%')),
                'k_bb_pct':      safe_float(row.get('K-BB%')),
                'whip':          safe_float(row.get('WHIP')),
                'swstr_pct':     safe_float(row.get('SwStr%')),
                'f_strike_pct':  safe_float(row.get('F-Strike%')),
                'lob_pct':       safe_float(row.get('LOB%')),
                'gb_pct':        safe_float(row.get('GB%')),
                'hard_pct':      safe_float(row.get('Hard%')),
                'barrel_pct':    safe_float(row.get('Barrel%')),
                'stuff_plus':    safe_float(row.get('Stuff+')),
                'location_plus': safe_float(row.get('Location+')),
                'pitching_plus': safe_float(row.get('Pitching+')),
                'war':           safe_float(row.get('WAR')),
            })
            result['sources'].append('fangraphs')

            # ERA-FIP gap — the regression risk signal
            # Positive = FIP > ERA = pitcher has been LUCKY = expect more runs
            # Negative = FIP < ERA = pitcher has been UNLUCKY = expect fewer runs
            era = result.get('era')
            fip = result.get('fip')
            if era is not None and fip is not None:
                gap = round(fip - era, 2)
                result['era_fip_gap'] = gap
                if gap >= 1.5:
                    result['era_fip_signal'] = 'REGRESSION_RISK_HIGH'
                    result['era_fip_note']   = (
                        f'FIP is {gap} above ERA — pitcher has been lucky. '
                        f'Expect regression: opposing team scores more.'
                    )
                elif gap >= 1.0:
                    result['era_fip_signal'] = 'REGRESSION_RISK_MODERATE'
                    result['era_fip_note']   = f'FIP is {gap} above ERA — mild regression risk.'
                elif gap <= -1.5:
                    result['era_fip_signal'] = 'IMPROVEMENT_LIKELY_HIGH'
                    result['era_fip_note']   = (
                        f'ERA is {abs(gap)} above FIP — pitcher has been unlucky. '
                        f'Expect improvement: opposing team scores fewer runs.'
                    )
                elif gap <= -1.0:
                    result['era_fip_signal'] = 'IMPROVEMENT_LIKELY_MODERATE'
                    result['era_fip_note']   = f'ERA is {abs(gap)} above FIP — mild improvement likely.'
                else:
                    result['era_fip_signal'] = 'NEUTRAL'
                    result['era_fip_note']   = 'ERA and FIP are aligned — no regression signal.'
    except Exception as e:
        result['fangraphs_error'] = str(e)

    # ── Savant: avg velocity per pitch type ─────────────────────────────────
    try:
        df_spd = statcast_pitcher_pitch_arsenal(season, minP=100, arsenal_type='avg_speed')
        spd_row = find_row(df_spd, 'last_name, first_name', f"{last}, {first}")
        if spd_row is None:
            spd_row = find_row(df_spd, 'player_name', display)
        if spd_row is not None:
            velo = {}
            for pt in ['ff', 'si', 'sl', 'ch', 'cu', 'fc', 'fs', 'kc']:
                v = safe_float(spd_row.get(f'{pt}_avg_speed'), 1)
                if v:
                    velo[f'{pt}_velo'] = v
            result['velo_by_pitch'] = velo
            result['sources'].append('savant_speed')
    except Exception as e:
        result['arsenal_speed_error'] = str(e)

    # ── Savant: avg spin rate per pitch type ────────────────────────────────
    try:
        df_spn = statcast_pitcher_pitch_arsenal(season, minP=100, arsenal_type='avg_spin')
        spn_row = find_row(df_spn, 'last_name, first_name', f"{last}, {first}")
        if spn_row is None:
            spn_row = find_row(df_spn, 'player_name', display)
        if spn_row is not None:
            spin = {}
            for pt in ['ff', 'si', 'sl', 'ch', 'cu', 'fc']:
                s = safe_float(spn_row.get(f'{pt}_avg_spin'), 0)
                if s:
                    spin[f'{pt}_spin'] = s
            result['spin_by_pitch'] = spin
            result['sources'].append('savant_spin')
    except Exception as e:
        result['arsenal_spin_error'] = str(e)

    # ── Savant: expected stats (xERA, xwOBA) ───────────────────────────────
    try:
        df_exp  = statcast_pitcher_expected_stats(season)
        exp_row = find_row(df_exp, 'player_name', display)
        if exp_row is not None:
            result['xera']  = safe_float(exp_row.get('xera'))
            result['xwoba'] = safe_float(exp_row.get('xwoba'))
            result['sources'].append('savant_expected')
    except Exception as e:
        result['expected_error'] = str(e)

    # ── Savant: percentile ranks ────────────────────────────────────────────
    try:
        df_pct  = statcast_pitcher_percentile_ranks(season)
        pct_row = find_row(df_pct, 'player_name', display)
        if pct_row is not None:
            result['percentile_ranks'] = {
                'xera':     safe_float(pct_row.get('xera'),            0),
                'k_pct':    safe_float(pct_row.get('k_percent'),       0),
                'bb_pct':   safe_float(pct_row.get('bb_percent'),      0),
                'hard_hit': safe_float(pct_row.get('hard_hit_percent'),0),
                'barrel':   safe_float(pct_row.get('brl_percent'),     0),
                'whiff':    safe_float(pct_row.get('whiff_percent'),   0),
            }
            result['sources'].append('savant_percentiles')
    except Exception as e:
        result['percentile_error'] = str(e)

    if not result['sources']:
        result['warning'] = (
            f'No data found for "{display}" in {season}. '
            'Check spelling — use last_first format e.g. verlander_justin'
        )

    return ok(result)


# ── RECENT FORM + VELOCITY TREND ────────────────────────────────────────────
# GET /api/baseball?type=recent&name=verlander_justin&starts=4
#
# Pulls last N starts from Statcast pitch-by-pitch data.
# Key output: velo_dip_flag — true when FF drops >=0.8mph from season avg.
# This is the sharpest pre-public injury/fatigue signal available.

def handle_recent(params):
    name          = params.get('name',      [''])[0]
    n_starts      = int(params.get('starts',    [4])[0])
    player_id_raw = params.get('player_id', [None])[0]
    season        = int(params.get('season', [datetime.now().year])[0])

    if not name and not player_id_raw:
        return err('name or player_id required')

    parts   = name.lower().split('_')
    last    = parts[0] if len(parts) > 0 else ''
    first   = parts[1] if len(parts) > 1 else ''
    display = f"{first.title()} {last.title()}"

    # Resolve MLBAM ID
    mlbam = int(player_id_raw) if player_id_raw else resolve_id(last, first)
    if not mlbam:
        return err(
            f'Could not find player ID for "{display}". '
            'Check spelling. Format: last_first e.g. verlander_justin',
            404
        )

    # Pull last 75 days of pitch data — covers ~10 SP starts
    try:
        df = statcast_pitcher(date_str(75), date_str(0), mlbam)
    except Exception as e:
        return err(f'Statcast fetch failed: {e}', 500)

    if df is None or df.empty:
        return err(f'No pitch data found for {display} (MLBAM ID: {mlbam})', 404)

    df = df[df['game_type'] == 'R'].copy()
    df['game_date'] = pd.to_datetime(df['game_date'])
    df = df.sort_values('game_date')

    # Build per-start stats — only appearances with 40+ pitches = SP start
    starts = []
    for game_date, gdf in df.groupby('game_date'):
        if len(gdf) < 40:
            continue

        ff   = gdf[gdf['pitch_type'].isin(['FF', 'FA'])]
        si   = gdf[gdf['pitch_type'] == 'SI']
        all_fb = gdf[gdf['pitch_type'].isin(['FF', 'FA', 'SI'])]

        total_pa = gdf[gdf['events'].notna()].shape[0]
        ks       = gdf[gdf['events'] == 'strikeout'].shape[0]
        bbs      = gdf[gdf['events'].isin(['walk', 'hit_by_pitch'])].shape[0]

        starts.append({
            'date':        str(game_date.date()),
            'pitches':     int(len(gdf)),
            'ff_velo':     safe_float(ff['release_speed'].mean(),       1) if not ff.empty else None,
            'si_velo':     safe_float(si['release_speed'].mean(),       1) if not si.empty else None,
            'fb_velo_avg': safe_float(all_fb['release_speed'].mean(),   1) if not all_fb.empty else None,
            'all_velo':    safe_float(gdf['release_speed'].mean(),      1),
            'ff_spin':     safe_float(ff['release_spin_rate'].mean(),   0) if (not ff.empty and 'release_spin_rate' in ff) else None,
            'extension':   safe_float(gdf['release_extension'].mean(),  2) if 'release_extension' in gdf else None,
            'k_pct':       round(ks  / total_pa, 3) if total_pa > 0 else None,
            'bb_pct':      round(bbs / total_pa, 3) if total_pa > 0 else None,
        })

    starts = starts[-n_starts:]
    if not starts:
        return err(f'No qualifying starts (40+ pitches) found in last 75 days for {display}')

    # Season-average FF velocity for comparison
    season_ff = None
    try:
        df_ars  = statcast_pitcher_pitch_arsenal(season, minP=100, arsenal_type='avg_speed')
        ars_row = find_row(df_ars, 'last_name, first_name', f"{last}, {first}")
        if ars_row is None:
            ars_row = find_row(df_ars, 'player_name', display)
        if ars_row is not None:
            season_ff = safe_float(ars_row.get('ff_avg_speed'), 1)
    except Exception:
        pass

    # Velocity dip calculation
    ff_velos    = [s['ff_velo'] for s in starts if s['ff_velo'] is not None]
    recent_ff   = round(sum(ff_velos) / len(ff_velos), 1) if ff_velos else None
    velo_dip    = round(recent_ff - season_ff, 1) if (recent_ff and season_ff) else None
    dip_flag    = velo_dip is not None and velo_dip <= -0.8

    # K% / BB% trend
    k_list  = [s['k_pct']  for s in starts if s['k_pct']  is not None]
    bb_list = [s['bb_pct'] for s in starts if s['bb_pct'] is not None]

    return ok({
        'name':            display,
        'player_id':       mlbam,
        'starts_analyzed': len(starts),
        'date_range':      f"{starts[0]['date']} to {starts[-1]['date']}",
        'starts':          starts,

        # Baseline
        'season_ff_velo':  season_ff,

        # Recent averages
        'recent_ff_velo':  recent_ff,
        'recent_k_pct':    round(sum(k_list)  / len(k_list),  3) if k_list  else None,
        'recent_bb_pct':   round(sum(bb_list) / len(bb_list), 3) if bb_list else None,

        # THE KEY SIGNAL
        'velo_dip':        velo_dip,
        'velo_dip_flag':   dip_flag,
        'velo_dip_note':   (
            f'FATIGUE/INJURY SIGNAL: FF velo down {abs(velo_dip)}mph vs season avg '
            f'({recent_ff}mph recent vs {season_ff}mph season). '
            f'Treat same as short rest — opposing team lambda +8-10%%.'
            if dip_flag else
            f'No meaningful velocity drop. Recent FF: {recent_ff}mph vs season: {season_ff}mph.'
        ),

        # Paste these directly into Apex pitching{} SIM block
        'apex_pitching_inputs': {
            'veloDipFlag':   dip_flag,
            'veloDipAmount': velo_dip,
        },
    })


# ── BULLPEN USAGE ────────────────────────────────────────────────────────────
# GET /api/baseball?type=bullpen&team=NYY&days=3
#
# Returns last N days of real pitch counts per reliever.
# Calculates combined top-2 pitches for direct Apex bullpen{} input.

def handle_bullpen(params):
    team = params.get('team', [''])[0].upper()
    days = int(params.get('days', [3])[0])

    if not team:
        return err(
            'team required — use 3-letter MLB abbreviation. '
            'Examples: NYY, LAD, HOU, BOS, CHC, ATL, SEA, NYM'
        )

    start_dt = date_str(days)
    end_dt   = date_str(0)

    try:
        df = statcast(start_dt, end_dt)
    except Exception as e:
        return err(f'Statcast fetch failed: {e}', 500)

    if df is None or df.empty:
        return err(f'No Statcast data available for {start_dt} to {end_dt}', 404)

    df['game_date'] = pd.to_datetime(df['game_date'])

    # Isolate this team's pitching appearances
    # Home team pitches during Top innings; Away team pitches during Bot innings
    home_pitching = df[(df['home_team'] == team) & (df['inning_topbot'] == 'Top')]
    away_pitching = df[(df['away_team'] == team) & (df['inning_topbot'] == 'Bot')]
    pitching_df   = pd.concat([home_pitching, away_pitching]).drop_duplicates()

    if pitching_df.empty:
        return err(
            f'No pitching data found for {team} in last {days} days. '
            'Check team abbreviation or try increasing days.'
        )

    # Build per-reliever stats
    yesterday   = (datetime.now() - timedelta(days=1)).date()
    relievers   = []

    for pid, pdf in pitching_df.groupby('pitcher'):
        name   = pdf['player_name'].iloc[0] if 'player_name' in pdf.columns else f'ID:{pid}'
        total  = len(pdf)
        dates  = sorted(pdf['game_date'].dt.date.unique())
        n_days = len(dates)

        # Skip starters — 60+ pitches in any single game = SP
        max_single = pdf.groupby('game_date').size().max()
        if max_single >= 60:
            continue

        relievers.append({
            'name':              str(name),
            'player_id':         int(pid),
            'total_pitches':     int(total),
            'days_appeared':     int(n_days),
            'pitched_yesterday': bool(yesterday in dates),
            'game_dates':        [str(d) for d in dates],
            'high_usage':        bool(total >= 30),
        })

    relievers.sort(key=lambda x: x['total_pitches'], reverse=True)

    # Apex bullpen{} inputs
    top2             = relievers[:2]
    top2_pitches     = sum(r['total_pitches'] for r in top2)
    closer_yesterday = any(r['pitched_yesterday'] and r['total_pitches'] >= 15 for r in top2)

    fatigue = (
        'HEAVY'    if top2_pitches >= 60 else
        'MODERATE' if top2_pitches >= 40 else
        'MILD'     if top2_pitches >= 25 else
        'FRESH'
    )

    return ok({
        'team':            team,
        'days_analyzed':   days,
        'date_range':      f'{start_dt} to {end_dt}',
        'total_relievers': len(relievers),
        'relievers':       relievers,

        # ── Paste this directly into your Apex bullpen{} SIM block ──────────
        'apex_bullpen_inputs': {
            'closerPitchedYesterday': closer_yesterday,
            'topTwoRelieverPitches':  int(top2_pitches),
            # Note: add bullpenERA separately from a pitching_stats_range lookup
        },

        'fatigue_level': fatigue,
        'fatigue_note': (
            f'Top-2 relievers combined {top2_pitches} pitches in last {days} days. '
            + (f'Closer/top arm pitched yesterday — likely limited. ' if closer_yesterday else '')
            + f'Lambda impact: 60+pts=+10%%, 40-59=+6%%, 25-39=+3%%, <25=0%%.'
        ),
    })


# ── VERCEL REQUEST HANDLER ───────────────────────────────────────────────────

class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        qtype  = params.get('type', [''])[0]

        if not PYBASEBALL_OK:
            status, body = err(
                f'pybaseball failed to import: {IMPORT_ERROR}. '
                'Check Vercel build logs and requirements.txt.',
                500
            )
        else:
            try:
                if   qtype == 'season':  status, body = handle_season(params)
                elif qtype == 'recent':  status, body = handle_recent(params)
                elif qtype == 'bullpen': status, body = handle_bullpen(params)
                else:
                    status, body = err(
                        'Missing or invalid type parameter. '
                        'Valid options: season | recent | bullpen. '
                        'Examples: '
                        '?type=season&name=verlander_justin&season=2026 | '
                        '?type=recent&name=verlander_justin&starts=4 | '
                        '?type=bullpen&team=NYY&days=3'
                    )
            except Exception as e:
                status, body = err(
                    f'Server error: {str(e)} — {traceback.format_exc()}',
                    500
                )

        self.send_response(status)
        self.send_header('Content-Type',                  'application/json')
        self.send_header('Access-Control-Allow-Origin',   '*')
        self.send_header('Access-Control-Allow-Methods',  'GET, OPTIONS')
        self.end_headers()
        self.wfile.write(body.encode('utf-8'))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.end_headers()

    def log_message(self, format, *args):
        pass  # suppress default server log noise
