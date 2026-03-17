// api/motogp.js — MotoGP stats via official MotoGP PulseLive API (no key required)
// Base: https://api.motogp.pulselive.com/motogp/v1
// Covers: seasons, events, riders, race results, qualifying, standings

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, year = "2025", event_id, session_id, rider_id } = req.query;

  const BASE = "https://api.motogp.pulselive.com/motogp/v1";

  // MotoGP category UUIDs (stable across seasons)
  // These are the main class IDs — fetched dynamically if needed
  const MOTOGP_CLASS = "e8c110ad-64aa-4e8e-8a86-f2f152f6a942"; // MotoGP
  const MOTO2_CLASS  = "7b198b5f-db6b-4a3a-8e46-9add7e44d7c6"; // Moto2
  const MOTO3_CLASS  = "1ab203aa-e292-4842-8bed-971911357af7"; // Moto3

  const headers = { "Accept": "application/json", "User-Agent": "Mozilla/5.0" };

  async function moto(path) {
    const url = `${BASE}/${path}`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`MotoGP API ${url} returned ${r.status}`);
    return r.json();
  }

  try {

    // ── SEASONS ───────────────────────────────────────────────────────────────
    if (type === "seasons") {
      const data = await moto("results/seasons");
      return res.status(200).json({
        type: "seasons",
        seasons: (data || []).map(s => ({
          seasonId: s.id,
          year: s.year,
          current: s.current,
        }))
      });
    }

    // ── EVENTS (race calendar) ────────────────────────────────────────────────
    if (type === "events" || type === "calendar") {
      // First get season ID for the year
      const seasons = await moto("results/seasons");
      const season = seasons.find(s => s.year == year) || seasons.find(s => s.current);
      if (!season) return res.status(200).json({ type: "events", data: null, message: "Season not found" });

      const data = await moto(`results/events?seasonUuid=${season.id}&isFinished=false`);
      const finished = await moto(`results/events?seasonUuid=${season.id}&isFinished=true`);
      const allEvents = [...(Array.isArray(data) ? data : []), ...(Array.isArray(finished) ? finished : [])];

      return res.status(200).json({
        type: "events",
        year,
        seasonId: season.id,
        events: allEvents
          .sort((a, b) => new Date(a.date_start) - new Date(b.date_start))
          .map(e => ({
            eventId: e.id,
            name: e.name,
            shortName: e.short_name,
            country: e.country?.name,
            circuit: e.circuit?.name,
            dateStart: e.date_start,
            dateEnd: e.date_end,
            finished: e.finished,
          }))
      });
    }

    // ── NEXT EVENT ────────────────────────────────────────────────────────────
    if (type === "next") {
      const seasons = await moto("results/seasons");
      const season = seasons.find(s => s.year == year) || seasons.find(s => s.current);
      if (!season) return res.status(200).json({ type: "next", data: null });

      const data = await moto(`results/events?seasonUuid=${season.id}&isFinished=false`);
      const upcoming = (Array.isArray(data) ? data : [])
        .filter(e => e.date_start)
        .sort((a, b) => new Date(a.date_start) - new Date(b.date_start));

      const next = upcoming[0];
      if (!next) {
        // Fall back to most recent finished event
        const finished = await moto(`results/events?seasonUuid=${season.id}&isFinished=true`);
        const recent = (Array.isArray(finished) ? finished : [])
          .sort((a, b) => new Date(b.date_start) - new Date(a.date_start))[0];
        return res.status(200).json({
          type: "next",
          isUpcoming: false,
          event: recent ? {
            eventId: recent.id,
            name: recent.name,
            country: recent.country?.name,
            circuit: recent.circuit?.name,
            dateStart: recent.date_start,
            finished: recent.finished,
          } : null
        });
      }

      return res.status(200).json({
        type: "next",
        isUpcoming: true,
        event: {
          eventId: next.id,
          name: next.name,
          country: next.country?.name,
          circuit: next.circuit?.name,
          dateStart: next.date_start,
          dateEnd: next.date_end,
        }
      });
    }

    // ── RIDERS (current season) ───────────────────────────────────────────────
    if (type === "riders") {
      const seasons = await moto("results/seasons");
      const season = seasons.find(s => s.year == year) || seasons.find(s => s.current);
      if (!season) return res.status(200).json({ type: "riders", data: null });

      const data = await moto(`results/riders?seasonUuid=${season.id}&categoryUuid=${MOTOGP_CLASS}`);
      return res.status(200).json({
        type: "riders",
        year,
        riders: (Array.isArray(data) ? data : data?.classification || []).map(r => ({
          riderId: r.rider?.id || r.id,
          name: r.rider?.full_name || r.full_name,
          number: r.rider?.number || r.number,
          nationality: r.rider?.country?.name,
          team: r.team?.name,
          constructor: r.constructor?.name,
        }))
      });
    }

    // ── STANDINGS ─────────────────────────────────────────────────────────────
    if (type === "standings") {
      const seasons = await moto("results/seasons");
      const season = seasons.find(s => s.year == year) || seasons.find(s => s.current);
      if (!season) return res.status(200).json({ type: "standings", data: null });

      const data = await moto(`results/standings?seasonUuid=${season.id}&categoryUuid=${MOTOGP_CLASS}`);
      const classification = data?.classification || data || [];

      return res.status(200).json({
        type: "standings",
        year,
        standings: classification.map(r => ({
          position: r.position,
          riderId: r.rider?.id,
          name: r.rider?.full_name,
          number: r.rider?.number,
          nationality: r.rider?.country?.name,
          team: r.team?.name,
          constructor: r.constructor?.name,
          points: r.points,
          wins: r.wins,
          podiums: r.podiums,
          poles: r.pole_positions,
          fastestLaps: r.fastest_laps,
        }))
      });
    }

    // ── RACE RESULTS for a specific event ────────────────────────────────────
    if (type === "results" && event_id) {
      // Get sessions for this event
      const sessions = await moto(`results/sessions?eventUuid=${event_id}`);
      const sessArr = Array.isArray(sessions) ? sessions : [];

      // Find RAC (race) session
      const raceSession = sessArr.find(s =>
        s.type === "RAC" || s.session === "RAC" || (s.type||"").toUpperCase().includes("RAC")
      ) || sessArr[sessArr.length - 1];

      if (!raceSession) return res.status(200).json({ type: "results", event_id, sessions: sessArr.map(s => ({ id: s.id, type: s.type })) });

      const results = await moto(`results/session/${raceSession.id}/classification?test=0`);
      const classification = results?.classification || results || [];

      return res.status(200).json({
        type: "results",
        eventId: event_id,
        sessionId: raceSession.id,
        sessionType: raceSession.type,
        results: classification.map(r => ({
          position: r.position,
          riderId: r.rider?.id,
          name: r.rider?.full_name,
          number: r.rider?.number,
          team: r.team?.name,
          constructor: r.constructor?.name,
          time: r.time,
          gap: r.gap,
          laps: r.total_laps || r.laps,
          points: r.points,
          status: r.status,
          fastestLap: r.best_lap,
        }))
      });
    }

    // ── SESSIONS for an event ────────────────────────────────────────────────
    if (type === "sessions" && event_id) {
      const data = await moto(`results/sessions?eventUuid=${event_id}`);
      return res.status(200).json({
        type: "sessions",
        eventId: event_id,
        sessions: (Array.isArray(data) ? data : []).map(s => ({
          sessionId: s.id,
          type: s.type,
          date: s.date,
          condition: s.condition?.track,
          weather: s.condition?.weather,
        }))
      });
    }

    // ── SESSION CLASSIFICATION (qualifying / practice results) ────────────────
    if (type === "classification" && session_id) {
      const data = await moto(`results/session/${session_id}/classification?test=0`);
      const classification = data?.classification || data || [];

      return res.status(200).json({
        type: "classification",
        sessionId: session_id,
        results: classification.map(r => ({
          position: r.position,
          name: r.rider?.full_name,
          number: r.rider?.number,
          team: r.team?.name,
          constructor: r.constructor?.name,
          time: r.time,
          gap: r.gap,
          speed: r.top_speed,
        }))
      });
    }

    // ── RIDER profile ────────────────────────────────────────────────────────
    if (type === "rider" && rider_id) {
      const data = await moto(`riders/${rider_id}`);
      return res.status(200).json({
        type: "rider",
        riderId: rider_id,
        name: data.full_name,
        number: data.number,
        nationality: data.country?.name,
        dateOfBirth: data.birth_date,
        birthplace: data.birth_city,
        team: data.team?.name,
        biography: data.biography?.slice(0, 300),
      });
    }

    return res.status(400).json({
      error: "Invalid type",
      validTypes: ["seasons", "events", "next", "riders", "standings", "results", "sessions", "classification", "rider"],
      examples: [
        "/api/motogp?type=next",
        "/api/motogp?type=events&year=2025",
        "/api/motogp?type=standings&year=2025",
        "/api/motogp?type=riders&year=2025",
        "/api/motogp?type=results&event_id=<uuid>",
        "/api/motogp?type=sessions&event_id=<uuid>",
        "/api/motogp?type=classification&session_id=<uuid>",
      ]
    });

  } catch (err) {
    console.error("MotoGP API error:", err);
    return res.status(500).json({ error: "MotoGP API error", detail: err.message });
  }
}
