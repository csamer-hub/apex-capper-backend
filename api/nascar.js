// api/nascar.js — NASCAR stats via NASCAR CDN (no key required)
// Source: cf.nascar.com/cacher
// URL pattern: /cacher/{year}/{series_id}/{feed}.json
// Series: 1=Cup, 2=Xfinity, 3=Trucks

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, year = "2026", series = "1", race_id } = req.query;
  const CDN = "https://cf.nascar.com/cacher";

  // Helper — fetch with error handling
  async function cdn(path) {
    const url = `${CDN}/${path}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`NASCAR CDN ${url} returned ${r.status}`);
    return r.json();
  }

  try {

    // ── SCHEDULE ─────────────────────────────────────────────────────────────
    if (type === "schedule") {
      const data = await cdn(`${year}/${series}/schedule-feed.json`);
      const races = (data?.response?.schedule || data || []);
      return res.status(200).json({
        type: "schedule", year, series,
        races: races.map(r => ({
          raceId: r.race_id,
          raceName: r.race_name,
          trackName: r.track_name,
          trackId: r.track_id,
          date: r.race_date || r.scheduled_start_time,
          laps: r.number_of_laps,
          distance: r.distance,
          trackLength: r.track_length,
          trackType: r.track_type,
          broadcastNetwork: r.broadcast_network,
          raceWeek: r.race_week,
          city: r.city,
          state: r.state,
        }))
      });
    }

    // ── NEXT RACE ─────────────────────────────────────────────────────────────
    if (type === "next") {
      const data = await cdn(`${year}/${series}/schedule-feed.json`);
      const races = (data?.response?.schedule || data || []);
      const now = new Date();

      const upcoming = races
        .filter(r => {
          const d = r.race_date || r.scheduled_start_time;
          return d && new Date(d) > now;
        })
        .sort((a, b) => new Date(a.race_date || a.scheduled_start_time) - new Date(b.race_date || b.scheduled_start_time));

      const next = upcoming[0] || races[races.length - 1]; // fallback to last race
      if (!next) return res.status(200).json({ type: "next", data: null });

      return res.status(200).json({
        type: "next",
        isUpcoming: upcoming.length > 0,
        race: {
          raceId: next.race_id,
          raceName: next.race_name,
          trackName: next.track_name,
          date: next.race_date || next.scheduled_start_time,
          laps: next.number_of_laps,
          distance: next.distance,
          trackLength: next.track_length,
          trackType: next.track_type,
          broadcastNetwork: next.broadcast_network,
          city: next.city,
          state: next.state,
        }
      });
    }

    // ── STANDINGS ─────────────────────────────────────────────────────────────
    if (type === "standings") {
      const data = await cdn(`${year}/${series}/standings-feed.json`);
      const rows = data?.response?.standings || data?.standings_rows || data || [];
      return res.status(200).json({
        type: "standings", year, series,
        standings: rows.slice(0, 40).map(d => ({
          position: d.position || d.pos || d.rank,
          driverId: d.driver_id,
          driverName: d.driver_name || `${d.first_name||''} ${d.last_name||''}`.trim(),
          carNumber: d.car_number,
          team: d.team_name,
          manufacturer: d.manufacturer,
          points: d.points || d.total_points,
          wins: d.wins,
          top5s: d.top_5 || d.top5,
          top10s: d.top_10 || d.top10,
          poles: d.poles,
          avgStart: d.avg_start_position,
          avgFinish: d.avg_finish_position,
          lapsLed: d.laps_led,
          playoffPoints: d.playoff_points,
        }))
      });
    }

    // ── DRIVERS ──────────────────────────────────────────────────────────────
    if (type === "drivers") {
      const data = await cdn(`${year}/${series}/drivers-feed.json`);
      const drivers = data?.response?.drivers || data || [];
      return res.status(200).json({
        type: "drivers", year, series,
        drivers: drivers.map(d => ({
          driverId: d.driver_id,
          name: d.driver_name || `${d.first_name||''} ${d.last_name||''}`.trim(),
          carNumber: d.car_number,
          team: d.team_name,
          manufacturer: d.manufacturer,
          hometown: d.hometown,
          age: d.age,
        }))
      });
    }

    // ── RACE RESULTS ─────────────────────────────────────────────────────────
    if (type === "results" && race_id) {
      const data = await cdn(`${year}/${series}/${race_id}/results-feed.json`);
      const results = data?.response?.results || data?.results || data || [];
      return res.status(200).json({
        type: "results", raceId: race_id, year, series,
        results: results
          .sort((a, b) => (parseInt(a.finishing_position)||99) - (parseInt(b.finishing_position)||99))
          .map(d => ({
            finishPos: d.finishing_position,
            startPos: d.starting_position,
            driverName: d.driver_name || `${d.first_name||''} ${d.last_name||''}`.trim(),
            carNumber: d.car_number,
            team: d.team_name,
            manufacturer: d.manufacturer,
            lapsCompleted: d.laps_completed,
            lapsLed: d.laps_led,
            status: d.finishing_status,
            points: d.points,
            playoffPoints: d.playoff_points,
            avgSpeed: d.average_speed,
          }))
      });
    }

    // ── RECENT RESULTS ────────────────────────────────────────────────────────
    if (type === "recent") {
      const data = await cdn(`${year}/${series}/schedule-feed.json`);
      const races = data?.response?.schedule || data || [];
      const now = new Date();

      const completed = races
        .filter(r => {
          const d = r.race_date || r.scheduled_start_time;
          return d && new Date(d) < now;
        })
        .sort((a, b) => new Date(b.race_date || b.scheduled_start_time) - new Date(a.race_date || a.scheduled_start_time));

      const latest = completed[0];
      if (!latest) return res.status(200).json({ type: "recent", data: null });

      let results = null;
      try {
        const rData = await cdn(`${year}/${series}/${latest.race_id}/results-feed.json`);
        results = (rData?.response?.results || rData?.results || rData || [])
          .sort((a, b) => (parseInt(a.finishing_position)||99) - (parseInt(b.finishing_position)||99))
          .slice(0, 20)
          .map(d => ({
            finishPos: d.finishing_position,
            startPos: d.starting_position,
            driverName: d.driver_name || `${d.first_name||''} ${d.last_name||''}`.trim(),
            carNumber: d.car_number,
            team: d.team_name,
            lapsLed: d.laps_led,
            status: d.finishing_status,
          }));
      } catch {}

      return res.status(200).json({
        type: "recent",
        race: {
          raceId: latest.race_id,
          raceName: latest.race_name,
          trackName: latest.track_name,
          date: latest.race_date || latest.scheduled_start_time,
        },
        results
      });
    }

    // ── LIVE feed ────────────────────────────────────────────────────────────
    if (type === "live") {
      try {
        const data = await cdn(`live/live_points_${series}.json`);
        return res.status(200).json({
          type: "live", series,
          data: (data?.live_points_rows || data || []).slice(0, 40).map(d => ({
            position: d.position,
            driverName: d.driver_name,
            carNumber: d.car_number,
            lapsLed: d.laps_led,
            status: d.status,
            delta: d.delta,
          }))
        });
      } catch {
        return res.status(200).json({ type: "live", status: "no active race", data: null });
      }
    }

    return res.status(400).json({
      error: "Invalid type",
      validTypes: ["schedule", "next", "standings", "drivers", "results", "recent", "live"],
      series_note: "series: 1=Cup, 2=Xfinity, 3=Trucks",
      examples: [
        "/api/nascar?type=next&year=2026&series=1",
        "/api/nascar?type=schedule&year=2026&series=1",
        "/api/nascar?type=standings&year=2026&series=1",
        "/api/nascar?type=drivers&year=2026&series=1",
        "/api/nascar?type=recent&year=2026&series=1",
        "/api/nascar?type=live&series=1",
      ]
    });

  } catch (err) {
    console.error("NASCAR API error:", err);
    return res.status(500).json({ error: "NASCAR API error", detail: err.message });
  }
}
