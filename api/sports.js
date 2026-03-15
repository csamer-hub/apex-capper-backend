export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const ODDS_API_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_API_KEY) {
    return res.status(500).json({ error: "ODDS_API_KEY not configured" });
  }

  try {
    const response = await fetch(
      `https://api.the-odds-api.com/v4/sports?apiKey=${ODDS_API_KEY}&all=true`
    );
    const data = await response.json();
    return res.status(200).json({ data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
