// Returns the top 3 wallets by wins for the current calendar month.
// Keys are namespaced by month (e.g. leaderboard:pvp:2026-09), so a new
// month simply starts with an empty board — no reset job needed.
const URL = process.env.KV_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN;

async function redis(cmd) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function currentMonthKey() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

export default async function handler(req, res) {
  if (!URL || !TOKEN) return res.status(500).json({ error: 'Server is missing KV_REST_API_URL / KV_REST_API_TOKEN.' });
  const mode = req.query.mode;
  if (mode !== 'pve' && mode !== 'pvp') return res.status(400).json({ error: 'mode must be "pve" or "pvp".' });

  const month = currentMonthKey();
  const key = 'leaderboard:' + mode + ':' + month;

  try {
    const raw = await redis(['ZREVRANGE', key, '0', '2', 'WITHSCORES']);
    const leaders = [];
    for (let i = 0; i < raw.length; i += 2) {
      leaders.push({ address: raw[i], wins: parseInt(raw[i + 1], 10) });
    }
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
    return res.status(200).json({ month, leaders });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to load leaderboard.' });
  }
}
