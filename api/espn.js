// api/espn.js — CORS proxy for ESPN's public JSON APIs.
// Some ESPN endpoints (notably /injuries) don't send Access-Control-Allow-Origin
// from every browser, so the Apex NFL Capper routes ESPN reads through here to
// get consistent CORS. Host-allowlisted to *.espn.com — never an open proxy.
//
// Usage from the app:  /api/espn?url=<full encoded ESPN URL>
//   e.g. /api/espn?url=https%3A%2F%2Fsite.api.espn.com%2Fapis%2Fsite%2Fv2%2Fsports%2Ffootball%2Fnfl%2Finjuries

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const target = (req.query.url || '').toString();
  let u;
  try { u = new URL(target); }
  catch (e) { return res.status(400).json({ error: 'invalid url' }); }

  // Only ESPN hosts, HTTPS only.
  if (u.protocol !== 'https:' || !/(^|\.)espn\.com$/i.test(u.hostname)) {
    return res.status(400).json({ error: 'host not allowed' });
  }

  try {
    const r = await fetch(target, {
      headers: { 'User-Agent': 'ApexNFL/1.0', 'Accept': 'application/json' }
    });
    const body = await r.text();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(r.status).send(body);
  } catch (e) {
    return res.status(502).json({ error: 'espn upstream failed: ' + (e && e.message) });
  }
}
