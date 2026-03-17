// api/f1.js — Formula 1 stats proxy via OpenF1 API (no key required)
// Free tier: all historical data since 2023, up to 3 req/sec
// Covers: meetings, sessions, drivers, qualifying, race results,
//         lap times, pit stops, stints, standings, weather

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, year = "2025", country, driver, session_key, limit = "20" } = req.query;

  const BASE = "https://api.openf1.org/v1";

  try {

    // ── MEETINGS — race calendar for a season ────────────────────────────────
    if (type === "meetings" || type === "calendar") {
      // OpenF1 has data from 2023 onwards
      const safeYear = Math.max(2023, parseInt(year));
      const url = `${BASE}/meetings?year=${safeYear}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`OpenF1 meetings returned ${r.status}`);
      const data = await r.json();
      if (!Array.isArray(data) || !data.length) {
        return res.status(200).json({ type: "meetings", year: safeYear, races: [], message: `No data available for ${safeYear}. OpenF1 covers 2023+.` });
      }

      return res.status(200).json({
        type: "meetings",
        year,
        races: data.map(m => ({
          meetingKey: m.meeting_key,
          meetingName: m.meeting_name,
          officialName: m.meeting_official_name,
          country: m.country_name,
          circuit: m.circuit_short_name,
          location: m.location,
          dateStart: m.date_start,
          year: m.year,
        }))
      });
    }

    // ── SESSIONS — qualifying, practice, race for a meeting ──────────────────
    if (type === "sessions") {
      let url = `${BASE}/sessions?year=${year}`;
      if (country) url += `&country_name=${encodeURIComponent(country)}`;
      if (session_key) url = `${BASE}/sessions?session_key=${session_key}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`OpenF1 sessions returned ${r.status}`);
      const data = await r.json();

      return res.status(200).json({
        type: "sessions",
        sessions: data.map(s => ({
          sessionKey: s.session_key,
          sessionName: s.session_name,
          sessionType: s.session_type,
          meetingKey: s.meeting_key,
          country: s.country_name,
          circuit: s.circuit_short_name,
          dateStart: s.date_start,
          dateEnd: s.date_end,
          year: s.year,
        }))
      });
    }

    // ── DRIVERS — for a session or year ─────────────────────────────────────
    if (type === "drivers") {
      let url = `${BASE}/drivers?`;
      if (session_key) url += `session_key=${session_key}`;
      else url += `session_key=latest`;
      if (driver) url += `&driver_number=${driver}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`OpenF1 drivers returned ${r.status}`);
      const data = await r.json();

      // Deduplicate by driver number (same driver appears in multiple sessions)
      const seen = new Set();
      const unique = data.filter(d => {
        if (seen.has(d.driver_number)) return false;
        seen.add(d.driver_number);
        return true;
      });

      return res.status(200).json({
        type: "drivers",
        drivers: unique.map(d => ({
          driverNumber: d.driver_number,
          name: d.full_name,
          abbreviation: d.name_acronym,
          team: d.team_name,
          teamColor: d.team_colour,
          nationality: d.country_code,
          headshotUrl: d.headshot_url,
        }))
      });
    }

    // ── QUALIFYING results ───────────────────────────────────────────────────
    if (type === "qualifying") {
      // First find the qualifying session key
      let sessUrl = `${BASE}/sessions?session_type=Qualifying&year=${year}`;
      if (country) sessUrl += `&country_name=${encodeURIComponent(country)}`;
      const sr = await fetch(sessUrl);
      const sessions = await sr.json();
      const sess = sessions[sessions.length - 1]; // most recent qualifying
      if (!sess) return res.status(200).json({ type: "qualifying", data: null, message: "No qualifying session found" });

      // Get laps to find fastest lap per driver (Q3 or best available)
      const lapUrl = `${BASE}/laps?session_key=${sess.session_key}&is_pit_out_lap=false`;
      const lr = await fetch(lapUrl);
      const laps = await lr.json();

      // Get drivers for name mapping
      const drvUrl = `${BASE}/drivers?session_key=${sess.session_key}`;
      const dr = await fetch(drvUrl);
      const drivers = await dr.json();
      const driverMap = {};
      drivers.forEach(d => { driverMap[d.driver_number] = d; });

      // Find best lap per driver
      const bestLaps = {};
      for (const lap of laps) {
        if (!lap.lap_duration) continue;
        const dn = lap.driver_number;
        if (!bestLaps[dn] || lap.lap_duration < bestLaps[dn].lapDuration) {
          bestLaps[dn] = {
            driverNumber: dn,
            name: driverMap[dn]?.full_name || `#${dn}`,
            team: driverMap[dn]?.team_name,
            lapDuration: lap.lap_duration,
            lapDurationFormatted: formatLapTime(lap.lap_duration),
            segment1: lap.duration_sector_1,
            segment2: lap.duration_sector_2,
            segment3: lap.duration_sector_3,
          };
        }
      }

      const sorted = Object.values(bestLaps)
        .sort((a, b) => a.lapDuration - b.lapDuration)
        .map((d, i) => ({ ...d, position: i + 1 }));

      return res.status(200).json({
        type: "qualifying",
        year,
        country: sess.country_name,
        circuit: sess.circuit_short_name,
        sessionKey: sess.session_key,
        date: sess.date_start?.slice(0, 10),
        grid: sorted
      });
    }

    // ── RACE RESULTS ─────────────────────────────────────────────────────────
    if (type === "race" || type === "results") {
      // Find race session
      let sessUrl = `${BASE}/sessions?session_type=Race&year=${year}`;
      if (country) sessUrl += `&country_name=${encodeURIComponent(country)}`;
      const sr = await fetch(sessUrl);
      const sessions = await sr.json();
      const sess = sessions[sessions.length - 1];
      if (!sess) return res.status(200).json({ type: "race", data: null, message: "No race session found" });

      // Get final positions
      const posUrl = `${BASE}/position?session_key=${sess.session_key}`;
      const pr = await fetch(posUrl);
      const positions = await pr.json();

      // Get drivers
      const drvUrl = `${BASE}/drivers?session_key=${sess.session_key}`;
      const dr = await fetch(drvUrl);
      const drivers = await dr.json();
      const driverMap = {};
      drivers.forEach(d => { driverMap[d.driver_number] = d; });

      // Get last known position per driver
      const finalPos = {};
      for (const p of positions) {
        finalPos[p.driver_number] = p.position;
      }

      // Get standings for points
      const standUrl = `${BASE}/championship_drivers?session_key=${sess.session_key}`;
      const standr = await fetch(standUrl).catch(() => ({ json: () => ([]) }));
      const standings = await standr.json().catch(() => []);
      const pointsMap = {};
      standings.forEach(s => { pointsMap[s.driver_number] = s.points; });

      const results = Object.entries(finalPos)
        .map(([dn, pos]) => ({
          position: pos,
          driverNumber: parseInt(dn),
          name: driverMap[dn]?.full_name || `#${dn}`,
          abbreviation: driverMap[dn]?.name_acronym,
          team: driverMap[dn]?.team_name,
          points: pointsMap[dn] || null,
        }))
        .sort((a, b) => a.position - b.position)
        .slice(0, parseInt(limit));

      return res.status(200).json({
        type: "race",
        year,
        country: sess.country_name,
        circuit: sess.circuit_short_name,
        sessionKey: sess.session_key,
        date: sess.date_start?.slice(0, 10),
        results
      });
    }

    // ── DRIVER CHAMPIONSHIP STANDINGS ────────────────────────────────────────
    if (type === "standings" || type === "championship") {
      // Get latest race session key
      const sessUrl = `${BASE}/sessions?session_type=Race&year=${year}`;
      const sr = await fetch(sessUrl);
      const sessions = await sr.json();
      const sess = sessions[sessions.length - 1];
      if (!sess) return res.status(200).json({ type: "standings", data: null });

      const url = `${BASE}/championship_drivers?session_key=${sess.session_key}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`OpenF1 standings returned ${r.status}`);
      const data = await r.json();

      // Get driver names
      const drvUrl = `${BASE}/drivers?session_key=${sess.session_key}`;
      const dr = await fetch(drvUrl);
      const drivers = await dr.json();
      const driverMap = {};
      drivers.forEach(d => { driverMap[d.driver_number] = d; });

      return res.status(200).json({
        type: "standings",
        year,
        asOf: sess.country_name,
        standings: data
          .sort((a, b) => a.position - b.position)
          .map(s => ({
            position: s.position,
            driverNumber: s.driver_number,
            name: driverMap[s.driver_number]?.full_name || `#${s.driver_number}`,
            abbreviation: driverMap[s.driver_number]?.name_acronym,
            team: driverMap[s.driver_number]?.team_name,
            points: s.points,
          }))
      });
    }

    // ── PIT STOP data ────────────────────────────────────────────────────────
    if (type === "pitstops") {
      // Find most recent race
      let sessUrl = `${BASE}/sessions?session_type=Race&year=${year}`;
      if (country) sessUrl += `&country_name=${encodeURIComponent(country)}`;
      const sr = await fetch(sessUrl);
      const sessions = await sr.json();
      const sess = sessions[sessions.length - 1];
      if (!sess) return res.status(200).json({ type: "pitstops", data: null });

      const url = `${BASE}/pit?session_key=${sess.session_key}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`OpenF1 pitstops returned ${r.status}`);
      const data = await r.json();

      // Get drivers
      const drvUrl = `${BASE}/drivers?session_key=${sess.session_key}`;
      const dr = await fetch(drvUrl);
      const drivers = await dr.json();
      const driverMap = {};
      drivers.forEach(d => { driverMap[d.driver_number] = d; });

      return res.status(200).json({
        type: "pitstops",
        country: sess.country_name,
        sessionKey: sess.session_key,
        pitstops: data.map(p => ({
          driverNumber: p.driver_number,
          name: driverMap[p.driver_number]?.full_name || `#${p.driver_number}`,
          team: driverMap[p.driver_number]?.team_name,
          lap: p.lap_number,
          stopDuration: p.stop_duration,
          pitDuration: p.pit_duration,
          date: p.date,
        })).sort((a, b) => a.stopDuration - b.stopDuration)
      });
    }

    // ── STINTS (tire strategy) ───────────────────────────────────────────────
    if (type === "stints") {
      let sessUrl = `${BASE}/sessions?session_type=Race&year=${year}`;
      if (country) sessUrl += `&country_name=${encodeURIComponent(country)}`;
      const sr = await fetch(sessUrl);
      const sessions = await sr.json();
      const sess = sessions[sessions.length - 1];
      if (!sess) return res.status(200).json({ type: "stints", data: null });

      const url = `${BASE}/stints?session_key=${sess.session_key}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`OpenF1 stints returned ${r.status}`);
      const data = await r.json();

      const drvUrl = `${BASE}/drivers?session_key=${sess.session_key}`;
      const dr = await fetch(drvUrl);
      const drivers = await dr.json();
      const driverMap = {};
      drivers.forEach(d => { driverMap[d.driver_number] = d; });

      // Group stints by driver
      const byDriver = {};
      for (const s of data) {
        const dn = s.driver_number;
        if (!byDriver[dn]) byDriver[dn] = { name: driverMap[dn]?.full_name || `#${dn}`, team: driverMap[dn]?.team_name, stints: [] };
        byDriver[dn].stints.push({
          stint: s.stint_number,
          compound: s.compound,
          lapStart: s.lap_start,
          lapEnd: s.lap_end,
          lapsOnTire: (s.lap_end - s.lap_start) + 1,
          tyreAgeAtStart: s.tyre_age_at_start,
        });
      }

      return res.status(200).json({
        type: "stints",
        country: sess.country_name,
        sessionKey: sess.session_key,
        drivers: Object.values(byDriver)
      });
    }

    // ── WEATHER during a session ─────────────────────────────────────────────
    if (type === "weather") {
      let key = session_key;
      if (!key) {
        // Get latest race session
        const sessUrl = `${BASE}/sessions?session_type=Race&year=${year}`;
        if (country) sessUrl += `&country_name=${encodeURIComponent(country)}`;
        const sr = await fetch(sessUrl);
        const sessions = await sr.json();
        key = sessions[sessions.length - 1]?.session_key;
      }
      if (!key) return res.status(200).json({ type: "weather", data: null });

      const url = `${BASE}/weather?session_key=${key}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`OpenF1 weather returned ${r.status}`);
      const data = await r.json();

      // Return last few readings
      const recent = data.slice(-5);
      return res.status(200).json({
        type: "weather",
        sessionKey: key,
        latest: recent.map(w => ({
          date: w.date,
          airTemp: w.air_temperature,
          trackTemp: w.track_temperature,
          humidity: w.humidity,
          rainfall: w.rainfall,
          windSpeed: w.wind_speed,
          windDirection: w.wind_direction,
        }))
      });
    }

    // ── NEXT RACE info ───────────────────────────────────────────────────────
    if (type === "next") {
      // Try current year first, fall back to previous year if empty
      const now = new Date();
      let next = null;
      let sessions = [];

      for (const tryYear of [year, String(parseInt(year) - 1)]) {
        const url = `${BASE}/meetings?year=${tryYear}`;
        const r = await fetch(url);
        if (!r.ok) continue;
        const data = await r.json();
        if (!Array.isArray(data) || !data.length) continue;

        // Try to find upcoming race
        const upcoming = data
          .filter(m => m.date_start && new Date(m.date_start) > now)
          .sort((a, b) => new Date(a.date_start) - new Date(b.date_start));

        if (upcoming.length > 0) {
          next = upcoming[0];
        } else {
          // No upcoming — return most recent past race
          next = data.sort((a, b) => new Date(b.date_start) - new Date(a.date_start))[0];
        }
        if (next) break;
      }

      if (!next) return res.status(200).json({ type: "next", data: null, message: "No race data available" });

      // Get sessions for this meeting
      try {
        const sessUrl = `${BASE}/sessions?meeting_key=${next.meeting_key}`;
        const sr = await fetch(sessUrl);
        sessions = sr.ok ? await sr.json() : [];
      } catch {}

      return res.status(200).json({
        type: "next",
        isUpcoming: new Date(next.date_start) > now,
        race: {
          meetingKey: next.meeting_key,
          name: next.meeting_name,
          officialName: next.meeting_official_name,
          country: next.country_name,
          circuit: next.circuit_short_name,
          location: next.location,
          dateStart: next.date_start,
          year: next.year,
        },
        sessions: sessions.map(s => ({
          sessionName: s.session_name,
          sessionType: s.session_type,
          sessionKey: s.session_key,
          dateStart: s.date_start,
        }))
      });
    }

    return res.status(400).json({
      error: "Invalid type",
      validTypes: ["calendar", "sessions", "drivers", "qualifying", "race", "standings", "pitstops", "stints", "weather", "next"],
      examples: [
        "/api/f1?type=calendar&year=2025",
        "/api/f1?type=next",
        "/api/f1?type=drivers",
        "/api/f1?type=standings&year=2025",
        "/api/f1?type=qualifying&year=2025&country=Bahrain",
        "/api/f1?type=race&year=2025&country=Bahrain",
        "/api/f1?type=pitstops&year=2025&country=Bahrain",
        "/api/f1?type=stints&year=2025&country=Bahrain",
        "/api/f1?type=weather&year=2025&country=Bahrain",
      ]
    });

  } catch (err) {
    console.error("F1 API error:", err);
    return res.status(500).json({ error: "F1 API error", detail: err.message });
  }
}

// Format lap time from seconds to mm:ss.sss
function formatLapTime(seconds) {
  if (!seconds) return null;
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3).padStart(6, "0");
  return `${mins}:${secs}`;
}
