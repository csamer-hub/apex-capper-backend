// api/nascar.js — NASCAR stats proxy via NASCAR CDN (no key required)
// Source: cf.nascar.com/cacher — official NASCAR data, free and public
// Covers: Cup Series schedule, standings, driver stats, race results, live feed

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, year = "2026", series = "1", race_id, driver_id } = req.query;
  // Series: 1=Cup, 2=Xfinity, 3=Trucks

  const CDN = "https://cf.nascar.com/cacher";

  try {

    // ── SCHEDULE ─────────────────────────────────────────────────────────────
    if (type === "schedule") {
      const url = `${CDN}/${year}/race_list_basic.json`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`NASCAR schedule returned ${r.status}`);
      const data = await r.json();

      // Filter by series
      const seriesNum = parseInt(series);
      const races = (data || [])
        .filter(r => r.series_id === seriesNum)
        .map(r => ({
          raceId: r.race_id,
          raceName: r.race_name,
          trackName: r.track_name,
          trackId: r.track_id,
          city: r.city,
          state: r.state,
          scheduledDate: r.scheduled_start_time,
          lapLength: r.lap_length,
          totalLaps: r.number_of_laps,
          distanceMiles: r.distance,
          seriesId: r.series_id,
          raceWeek: r.race_week,
          broadcastNetwork: r.broadcast_network,
        }));

      return res.status(200).json({ type: "schedule", year, series: seriesNum, races });
    }

    // ── STANDINGS ─────────────────────────────────────────────────────────────
    if (type === "standings") {
      const url = `${CDN}/${year}/standings/standings_${series}.json`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`NASCAR standings returned ${r.status}`);
      const data = await r.json();

      const entries = (data?.standings_rows || data || []).slice(0, 40);
      return res.status(200).json({
        type: "standings",
        year,
        series,
        standings: entries.map(d => ({
          position: d.position || d.pos,
          driverId: d.driver_id,
          driverName: d.driver_name || `${d.first_name} ${d.last_name}`,
          carNumber: d.car_number,
          teamName: d.team_name,
          points: d.points,
          wins: d.wins,
          top5s: d.top_5,
          top10s: d.top_10,
          poles: d.poles,
          avgStart: d.avg_start_position,
          avgFinish: d.avg_finish_position,
          dnfs: d.dnfs,
          lapsLed: d.laps_led,
          playoffPoints: d.playoff_points,
          inPlayoffs: d.in_playoffs || d.advanced_to_round_of_12 || false,
        }))
      });
    }

    // ── DRIVERS list ─────────────────────────────────────────────────────────
    if (type === "drivers") {
      const url = `${CDN}/${year}/drivers.json`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`NASCAR drivers returned ${r.status}`);
      const data = await r.json();

      const drivers = (data || []).filter(d => !series || d.series_id == series);
      return res.status(200).json({
        type: "drivers",
        year,
        drivers: drivers.map(d => ({
          driverId: d.driver_id,
          name: `${d.first_name || ''} ${d.last_name || d.driver_name || ''}`.trim(),
          carNumber: d.car_number,
          team: d.team_name,
          manufacturer: d.manufacturer,
          seriesId: d.series_id,
          hometown: d.hometown,
          age: d.age,
        }))
      });
    }

    // ── RACE RESULTS ─────────────────────────────────────────────────────────
    if (type === "results" && race_id) {
      const url = `${CDN}/${year}/race_results/${race_id}_results.json`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`NASCAR results returned ${r.status}`);
      const data = await r.json();

      const results = (data?.results || data || []);
      return res.status(200).json({
        type: "results",
        raceId: race_id,
        year,
        results: results.map(d => ({
          finishPos: d.finishing_position,
          startPos: d.starting_position,
          driverId: d.driver_id,
          driverName: d.driver_name || `${d.first_name} ${d.last_name}`,
          carNumber: d.car_number,
          team: d.team_name,
          manufacturer: d.manufacturer,
          lapsCompleted: d.laps_completed,
          lapsLed: d.laps_led,
          status: d.finishing_status,
          points: d.points,
          playoffPoints: d.playoff_points,
          pitsStops: d.num_pit_stops,
          avgSpeed: d.average_speed,
          dnf: d.finishing_status !== "Running",
        })).sort((a, b) => a.finishPos - b.finishPos)
      });
    }

    // ── RECENT RESULTS (latest completed race) ───────────────────────────────
    if (type === "recent") {
      // Get schedule first
      const schedUrl = `${CDN}/${year}/race_list_basic.json`;
      const sr = await fetch(schedUrl);
      if (!sr.ok) throw new Error(`NASCAR schedule returned ${sr.status}`);
      const sched = await sr.json();

      const seriesNum = parseInt(series);
      const now = new Date();
      const completed = (sched || [])
        .filter(r => r.series_id === seriesNum && new Date(r.scheduled_start_time) < now)
        .sort((a, b) => new Date(b.scheduled_start_time) - new Date(a.scheduled_start_time));

      if (!completed.length) return res.status(200).json({ type: "recent", data: null });

      const latest = completed[0];
      const rUrl = `${CDN}/${year}/race_results/${latest.race_id}_results.json`;
      const rr = await fetch(rUrl);
      if (!rr.ok) return res.status(200).json({ type: "recent", race: latest, results: null });
      const rData = await rr.json();

      return res.status(200).json({
        type: "recent",
        race: {
          raceId: latest.race_id,
          raceName: latest.race_name,
          trackName: latest.track_name,
          date: latest.scheduled_start_time,
        },
        results: (rData?.results || rData || [])
          .sort((a, b) => (a.finishing_position || 99) - (b.finishing_position || 99))
          .slice(0, 20)
          .map(d => ({
            finishPos: d.finishing_position,
            startPos: d.starting_position,
            driverName: d.driver_name || `${d.first_name} ${d.last_name}`,
            carNumber: d.car_number,
            team: d.team_name,
            lapsLed: d.laps_led,
            status: d.finishing_status,
          }))
      });
    }

    // ── NEXT RACE ────────────────────────────────────────────────────────────
    if (type === "next") {
      const schedUrl = `${CDN}/${year}/race_list_basic.json`;
      const sr = await fetch(schedUrl);
      if (!sr.ok) throw new Error(`NASCAR schedule returned ${sr.status}`);
      const sched = await sr.json();

      const seriesNum = parseInt(series);
      const now = new Date();
      const upcoming = (sched || [])
        .filter(r => r.series_id === seriesNum && new Date(r.scheduled_start_time) > now)
        .sort((a, b) => new Date(a.scheduled_start_time) - new Date(b.scheduled_start_time));

      const next = upcoming[0];
      if (!next) return res.status(200).json({ type: "next", data: null });

      // Try to get entry list if available
      let entryList = [];
      try {
        const eUrl = `${CDN}/${year}/entry_lists/${next.race_id}_entry_list.json`;
        const er = await fetch(eUrl);
        if (er.ok) {
          const eData = await er.json();
          entryList = (eData || []).map(d => ({
            carNumber: d.car_number,
            driverName: d.driver_name || `${d.first_name} ${d.last_name}`,
            team: d.team_name,
            manufacturer: d.manufacturer,
          }));
        }
      } catch {}

      return res.status(200).json({
        type: "next",
        race: {
          raceId: next.race_id,
          raceName: next.race_name,
          trackName: next.track_name,
          city: next.city,
          state: next.state,
          date: next.scheduled_start_time,
          lapLength: next.lap_length,
          totalLaps: next.number_of_laps,
          distanceMiles: next.distance,
          broadcastNetwork: next.broadcast_network,
          trackType: next.track_type,
        },
        entryList
      });
    }

    // ── LIVE race feed ───────────────────────────────────────────────────────
    if (type === "live") {
      const url = `${CDN}/live/live_points_${series}.json`;
      const r = await fetch(url);
      if (!r.ok) return res.status(200).json({ type: "live", status: "no active race", data: null });
      const data = await r.json();

      return res.status(200).json({
        type: "live",
        series,
        data: (data?.live_points_rows || data || []).slice(0, 40).map(d => ({
          position: d.position,
          driverId: d.driver_id,
          driverName: d.driver_name,
          carNumber: d.car_number,
          lapsLed: d.laps_led,
          lastLapSpeed: d.last_lap_speed,
          status: d.status,
          delta: d.delta,
        }))
      });
    }

    // ── TRACK info ───────────────────────────────────────────────────────────
    if (type === "tracks") {
      const url = `${CDN}/${year}/tracks.json`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`NASCAR tracks returned ${r.status}`);
      const data = await r.json();

      return res.status(200).json({
        type: "tracks",
        year,
        tracks: (data || []).map(t => ({
          trackId: t.track_id,
          trackName: t.track_name,
          city: t.city,
          state: t.state,
          lapLength: t.lap_length,
          trackType: t.track_type, // oval, road, superspeedway
          seatingCapacity: t.seating_capacity,
        }))
      });
    }

    return res.status(400).json({
      error: "Invalid type",
      validTypes: ["schedule", "standings", "drivers", "results", "recent", "next", "live", "tracks"],
      series_note: "series: 1=Cup, 2=Xfinity, 3=Trucks",
      examples: [
        "/api/nascar?type=next&series=1",
        "/api/nascar?type=schedule&year=2026&series=1",
        "/api/nascar?type=standings&year=2026&series=1",
        "/api/nascar?type=drivers&year=2026&series=1",
        "/api/nascar?type=recent&series=1",
        "/api/nascar?type=results&race_id=1234&year=2026",
        "/api/nascar?type=live&series=1",
        "/api/nascar?type=tracks&year=2026",
      ]
    });

  } catch (err) {
    console.error("NASCAR API error:", err);
    return res.status(500).json({ error: "NASCAR API error", detail: err.message });
  }
}
