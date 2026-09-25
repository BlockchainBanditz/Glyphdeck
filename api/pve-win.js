// Records a practice-mode (PvE) win for the leaderboard. Client-reported,
// since practice battles run entirely in the browser with no server
// referee — same tradeoff most casual-game leaderboards accept.
const URL = process.env.KV_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN;
const MONTH_TTL_SECONDS = 40 * 24 * 60 * 60; // ~40 days, auto-cleans old months

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!URL || !TOKEN) return res.status(500).json({ error: 'Server is missing KV_REST_API_URL / KV_REST_API_TOKEN.' });

  const { address } = req.body || {};
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'A valid wallet address is required.' });
  }

  const key = 'leaderboard:pve:' + currentMonthKey();
  try {
    await redis(['ZINCRBY', key, '1', address.toLowerCase()]);
    await redis(['EXPIRE', key, String(MONTH_TTL_SECONDS)]);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to record win.' });
  }
}
