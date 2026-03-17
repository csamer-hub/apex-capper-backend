// api/motorsports.js — F1 + NASCAR combined endpoint
// Routes by series param: series=f1 or series=nascar (default=f1)
// F1: OpenF1 API (free, no key, 2023+)
// NASCAR: NASCAR CDN (free, no key)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { series = "f1", type, year = "2026", country, driver,
          session_key, race_id, limit = "20", cup = "1" } = req.query;

  // ════════════════════════════════════════════════════════
  // F1 — OpenF1 API
  // ════════════════════════════════════════════════════════
  if (series === "f1") {
    const BASE = "https://api.openf1.org/v1";
    const h = { "Accept": "application/json", "User-Agent": "Mozilla/5.0" };

    async function f1(path) {
      const r = await fetch(`${BASE}/${path}`, { headers: h });
      if (!r.ok) throw new Error(`OpenF1 ${path} returned ${r.status}`);
      return r.json();
    }

    function formatLapTime(s) {
      if (!s) return null;
      const m = Math.floor(s / 60);
      return `${m}:${(s % 60).toFixed(3).padStart(6,"0")}`;
    }

    try {
      if (type === "raw") {
        const path = req.query.path || "meetings?year=2025";
        const r = await fetch(`${BASE}/${path}`, { headers: h });
        const text = await r.text();
        return res.status(200).json({ status: r.status, url: `${BASE}/${path}`, preview: text.slice(0,2000) });
      }

      if (type === "calendar" || type === "meetings") {
        const safeYear = Math.max(2023, parseInt(year));
        const data = await f1(`meetings?year=${safeYear}`);
        if (!Array.isArray(data) || !data.length)
          return res.status(200).json({ type:"calendar", year:safeYear, races:[], message:"No data. OpenF1 covers 2023+." });
        return res.status(200).json({
          type:"calendar", year:safeYear,
          races: data.map(m => ({
            meetingKey:m.meeting_key, name:m.meeting_name,
            country:m.country_name, circuit:m.circuit_short_name,
            location:m.location, dateStart:m.date_start, year:m.year,
          }))
        });
      }

      if (type === "next") {
        const now = new Date();
        for (const tryYear of [year, String(parseInt(year)-1)]) {
          const safeYear = Math.max(2023, parseInt(tryYear));
          const data = await f1(`meetings?year=${safeYear}`).catch(()=>[]);
          if (!Array.isArray(data) || !data.length) continue;
          const upcoming = data.filter(m=>m.date_start&&new Date(m.date_start)>now)
            .sort((a,b)=>new Date(a.date_start)-new Date(b.date_start));
          const next = upcoming[0] || data.sort((a,b)=>new Date(b.date_start)-new Date(a.date_start))[0];
          if (!next) continue;
          let sessions = [];
          try { const sr = await f1(`sessions?meeting_key=${next.meeting_key}`); sessions = sr; } catch {}
          return res.status(200).json({
            type:"next", series:"f1", isUpcoming:upcoming.length>0,
            race:{ meetingKey:next.meeting_key, name:next.meeting_name, country:next.country_name,
                   circuit:next.circuit_short_name, location:next.location, dateStart:next.date_start, year:next.year },
            sessions:(sessions||[]).map(s=>({ sessionName:s.session_name, sessionType:s.session_type, sessionKey:s.session_key, dateStart:s.date_start }))
          });
        }
        return res.status(200).json({ type:"next", series:"f1", data:null });
      }

      if (type === "drivers") {
        const key = session_key || "latest";
        let url = `drivers?session_key=${key}`;
        if (driver) url += `&driver_number=${driver}`;
        const data = await f1(url);
        const seen = new Set();
        const unique = data.filter(d => { if(seen.has(d.driver_number)) return false; seen.add(d.driver_number); return true; });
        return res.status(200).json({ type:"drivers", series:"f1",
          drivers: unique.map(d=>({ driverNumber:d.driver_number, name:d.full_name, abbreviation:d.name_acronym, team:d.team_name, nationality:d.country_code }))
        });
      }

      if (type === "standings") {
        const sessUrl = `sessions?session_type=Race&year=${Math.max(2023,parseInt(year))}`;
        const sessions = await f1(sessUrl);
        const sess = sessions[sessions.length-1];
        if (!sess) return res.status(200).json({ type:"standings", series:"f1", data:null });
        const data = await f1(`championship_drivers?session_key=${sess.session_key}`);
        const drivers = await f1(`drivers?session_key=${sess.session_key}`);
        const dm = {}; drivers.forEach(d=>{ dm[d.driver_number]=d; });
        return res.status(200).json({
          type:"standings", series:"f1", year, asOf:sess.country_name,
          standings: data.sort((a,b)=>a.position-b.position).map(s=>({
            position:s.position, driverNumber:s.driver_number,
            name:dm[s.driver_number]?.full_name||`#${s.driver_number}`,
            abbreviation:dm[s.driver_number]?.name_acronym, team:dm[s.driver_number]?.team_name, points:s.points,
          }))
        });
      }

      if (type === "qualifying") {
        let sessUrl = `sessions?session_type=Qualifying&year=${Math.max(2023,parseInt(year))}`;
        if (country) sessUrl += `&country_name=${encodeURIComponent(country)}`;
        const sessions = await f1(sessUrl);
        const sess = sessions[sessions.length-1];
        if (!sess) return res.status(200).json({ type:"qualifying", series:"f1", data:null });
        const [laps, driversData] = await Promise.all([
          f1(`laps?session_key=${sess.session_key}&is_pit_out_lap=false`),
          f1(`drivers?session_key=${sess.session_key}`)
        ]);
        const dm = {}; driversData.forEach(d=>{ dm[d.driver_number]=d; });
        const best = {};
        for (const lap of laps) {
          if (!lap.lap_duration) continue;
          if (!best[lap.driver_number] || lap.lap_duration < best[lap.driver_number].lapDuration)
            best[lap.driver_number] = { driverNumber:lap.driver_number, name:dm[lap.driver_number]?.full_name||`#${lap.driver_number}`,
              team:dm[lap.driver_number]?.team_name, lapDuration:lap.lap_duration, lapFormatted:formatLapTime(lap.lap_duration) };
        }
        return res.status(200).json({
          type:"qualifying", series:"f1", country:sess.country_name, circuit:sess.circuit_short_name,
          date:sess.date_start?.slice(0,10),
          grid: Object.values(best).sort((a,b)=>a.lapDuration-b.lapDuration).map((d,i)=>({...d,position:i+1}))
        });
      }

      if (type === "pitstops") {
        let sessUrl = `sessions?session_type=Race&year=${Math.max(2023,parseInt(year))}`;
        if (country) sessUrl += `&country_name=${encodeURIComponent(country)}`;
        const sessions = await f1(sessUrl);
        const sess = sessions[sessions.length-1];
        if (!sess) return res.status(200).json({ type:"pitstops", series:"f1", data:null });
        const [data, driversData] = await Promise.all([
          f1(`pit?session_key=${sess.session_key}`),
          f1(`drivers?session_key=${sess.session_key}`)
        ]);
        const dm = {}; driversData.forEach(d=>{ dm[d.driver_number]=d; });
        return res.status(200).json({
          type:"pitstops", series:"f1", country:sess.country_name,
          pitstops: data.map(p=>({ driverNumber:p.driver_number, name:dm[p.driver_number]?.full_name||`#${p.driver_number}`,
            team:dm[p.driver_number]?.team_name, lap:p.lap_number, stopDuration:p.stop_duration }))
            .sort((a,b)=>a.stopDuration-b.stopDuration)
        });
      }

      if (type === "weather") {
        let key = session_key;
        if (!key) {
          const sessUrl = `sessions?session_type=Race&year=${Math.max(2023,parseInt(year))}`;
          const sessions = await f1(sessUrl);
          key = sessions[sessions.length-1]?.session_key;
        }
        if (!key) return res.status(200).json({ type:"weather", series:"f1", data:null });
        const data = await f1(`weather?session_key=${key}`);
        return res.status(200).json({
          type:"weather", series:"f1", sessionKey:key,
          latest: data.slice(-3).map(w=>({ date:w.date, airTemp:w.air_temperature, trackTemp:w.track_temperature,
            humidity:w.humidity, rainfall:w.rainfall, windSpeed:w.wind_speed }))
        });
      }

      return res.status(400).json({ error:"Invalid type for F1", validTypes:["calendar","next","drivers","standings","qualifying","pitstops","weather","raw"] });

    } catch(err) {
      return res.status(500).json({ error:"F1 API error", detail:err.message });
    }
  }

  // ════════════════════════════════════════════════════════
  // NASCAR — NASCAR CDN
  // ════════════════════════════════════════════════════════
  if (series === "nascar") {
    const CDN = "https://cf.nascar.com/cacher";

    async function nascar(path) {
      const r = await fetch(`${CDN}/${path}`);
      if (!r.ok) throw new Error(`NASCAR CDN ${path} returned ${r.status}`);
      return r.json();
    }

    function toArray(data) {
      return Array.isArray(data) ? data
        : Array.isArray(data?.response?.schedule) ? data.response.schedule
        : Array.isArray(data?.response?.standings) ? data.response.standings
        : Array.isArray(data?.response?.drivers) ? data.response.drivers
        : Array.isArray(data?.response) ? data.response
        : Array.isArray(data?.standings_rows) ? data.standings_rows
        : Array.isArray(data?.results) ? data.results
        : [];
    }

    try {
      if (type === "raw") {
        const path = req.query.path || `${year}/${cup}/schedule-feed.json`;
        const r = await fetch(`${CDN}/${path}`);
        const text = await r.text();
        return res.status(200).json({ status:r.status, url:`${CDN}/${path}`, preview:text.slice(0,2000) });
      }

      if (type === "schedule") {
        const data = await nascar(`${year}/${cup}/schedule-feed.json`);
        const races = toArray(data);
        return res.status(200).json({ type:"schedule", year, series:"nascar", cup,
          races: races.map(r=>({ raceId:r.race_id, raceName:r.race_name, trackName:r.track_name,
            date:r.race_date||r.scheduled_start_time, laps:r.number_of_laps, distance:r.distance,
            trackType:r.track_type, city:r.city, state:r.state, broadcast:r.broadcast_network }))
        });
      }

      if (type === "next") {
        const data = await nascar(`${year}/${cup}/schedule-feed.json`);
        const races = toArray(data);
        const now = new Date();
        const upcoming = races.filter(r=>{ const d=r.race_date||r.scheduled_start_time; return d&&new Date(d)>now; })
          .sort((a,b)=>new Date(a.race_date||a.scheduled_start_time)-new Date(b.race_date||b.scheduled_start_time));
        const next = upcoming[0] || races[races.length-1];
        if (!next) return res.status(200).json({ type:"next", series:"nascar", data:null });
        return res.status(200).json({ type:"next", series:"nascar", isUpcoming:upcoming.length>0,
          race:{ raceId:next.race_id, raceName:next.race_name, trackName:next.track_name,
            date:next.race_date||next.scheduled_start_time, laps:next.number_of_laps, distance:next.distance,
            trackType:next.track_type, city:next.city, state:next.state, broadcast:next.broadcast_network }
        });
      }

      if (type === "standings") {
        const data = await nascar(`${year}/${cup}/standings-feed.json`);
        const rows = toArray(data);
        return res.status(200).json({ type:"standings", year, series:"nascar", cup,
          standings: rows.slice(0,40).map(d=>({ position:d.position||d.pos||d.rank,
            driverName:d.driver_name||`${d.first_name||''} ${d.last_name||''}`.trim(),
            carNumber:d.car_number, team:d.team_name, manufacturer:d.manufacturer,
            points:d.points||d.total_points, wins:d.wins, top5s:d.top_5||d.top5,
            top10s:d.top_10||d.top10, avgFinish:d.avg_finish_position, lapsLed:d.laps_led,
            playoffPoints:d.playoff_points }))
        });
      }

      if (type === "drivers") {
        const data = await nascar(`${year}/${cup}/drivers-feed.json`);
        const drivers = toArray(data);
        return res.status(200).json({ type:"drivers", year, series:"nascar", cup,
          drivers: drivers.map(d=>({ driverId:d.driver_id,
            name:d.driver_name||`${d.first_name||''} ${d.last_name||''}`.trim(),
            carNumber:d.car_number, team:d.team_name, manufacturer:d.manufacturer }))
        });
      }

      if (type === "recent") {
        const data = await nascar(`${year}/${cup}/schedule-feed.json`);
        const races = toArray(data);
        const now = new Date();
        const completed = races.filter(r=>{ const d=r.race_date||r.scheduled_start_time; return d&&new Date(d)<now; })
          .sort((a,b)=>new Date(b.race_date||b.scheduled_start_time)-new Date(a.race_date||a.scheduled_start_time));
        const latest = completed[0];
        if (!latest) return res.status(200).json({ type:"recent", series:"nascar", data:null });
        let results = null;
        try {
          const rData = await nascar(`${year}/${cup}/${latest.race_id}/results-feed.json`);
          results = toArray(rData).sort((a,b)=>(parseInt(a.finishing_position)||99)-(parseInt(b.finishing_position)||99))
            .slice(0,20).map(d=>({ finishPos:d.finishing_position, startPos:d.starting_position,
              driverName:d.driver_name||`${d.first_name||''} ${d.last_name||''}`.trim(),
              carNumber:d.car_number, team:d.team_name, lapsLed:d.laps_led, status:d.finishing_status }));
        } catch {}
        return res.status(200).json({ type:"recent", series:"nascar",
          race:{ raceId:latest.race_id, raceName:latest.race_name, trackName:latest.track_name,
            date:latest.race_date||latest.scheduled_start_time }, results });
      }

      if (type === "live") {
        try {
          const data = await nascar(`live/live_points_${cup}.json`);
          return res.status(200).json({ type:"live", series:"nascar", cup,
            data:(data?.live_points_rows||data||[]).slice(0,40).map(d=>({
              position:d.position, driverName:d.driver_name, carNumber:d.car_number,
              lapsLed:d.laps_led, status:d.status, delta:d.delta }))
          });
        } catch { return res.status(200).json({ type:"live", series:"nascar", status:"no active race", data:null }); }
      }

      return res.status(400).json({ error:"Invalid type for NASCAR", validTypes:["schedule","next","standings","drivers","recent","live","raw"] });

    } catch(err) {
      return res.status(500).json({ error:"NASCAR API error", detail:err.message });
    }
  }

  return res.status(400).json({ error:"Invalid series", validSeries:["f1","nascar"],
    examples:[
      "/api/motorsports?series=f1&type=next",
      "/api/motorsports?series=f1&type=standings&year=2025",
      "/api/motorsports?series=f1&type=qualifying&country=Bahrain",
      "/api/motorsports?series=nascar&type=next&year=2026&cup=1",
      "/api/motorsports?series=nascar&type=standings&year=2026&cup=1",
      "/api/motorsports?series=nascar&type=recent&year=2026&cup=1",
    ]
  });
}
