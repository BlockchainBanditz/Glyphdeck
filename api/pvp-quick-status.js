// Poll this while waiting in the public queue to find out if we've been matched.
const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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

export default async function handler(req, res) {
  if (!URL || !TOKEN) return res.status(500).json({ error: 'Server is missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.' });
  const ticket = req.query.ticket;
  if (!ticket) return res.status(400).json({ error: 'Missing ticket.' });

  const raw = await redis(['GET', 'ticket:' + ticket]);
  if (!raw) return res.status(200).json({ matched: false });

  return res.status(200).json(Object.assign({ matched: true }, JSON.parse(raw)));
}
