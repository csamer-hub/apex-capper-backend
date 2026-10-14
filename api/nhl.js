// api/nhl.js — CORS proxy for the NHL's official stats API (api-web.nhle.com).
// The NHL API returns no Access-Control-Allow-Origin header, so the browser
// blocks direct fetches from the Apex Capper page. This forwards the request
// server-side and adds CORS, so the client can read schedules + box scores.
//
// Deploy: drop this file at  api/nhl.js  in your apex-capper-backend repo,
// commit, and let Vercel redeploy (same as api/apex.js).
//
// Usage from the app:  /api/nhl?path=/v1/roster/TBL/current

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = (req.query.path || '').toString();
  // Only allow NHL API v1 paths — never an open proxy.
  if (!/^\/v1\/[A-Za-z0-9/_\-?.=&]*$/.test(path)) {
    return res.status(400).json({ error: 'invalid path' });
  }

  try {
    const r = await fetch('https://api-web.nhle.com' + path, {
      headers: { 'User-Agent': 'ApexCapper/2.6', 'Accept': 'application/json' }
    });
    const body = await r.text();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(r.status).send(body);
  } catch (e) {
    return res.status(502).json({ error: 'nhl upstream failed: ' + (e && e.message) });
  }
}
