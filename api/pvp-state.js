// Returns the current state of a match so the client can render it.
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

function publicView(match) {
  const strip = (p) => p && { name: p.name, card: p.card, hp: p.hp, maxHp: p.maxHp, defending: p.defending };
  return {
    status: match.status,
    turn: match.turn,
    winner: match.winner,
    log: match.log,
    code: match.code,
    players: { p1: strip(match.players.p1), p2: strip(match.players.p2) }
  };
}

export default async function handler(req, res) {
  if (!URL || !TOKEN) return res.status(500).json({ error: 'Server is missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.' });
  const { matchId, role, token } = req.query;
  if (!matchId || !role || !token) return res.status(400).json({ error: 'Missing matchId, role or token.' });

  const raw = await redis(['GET', 'match:' + matchId]);
  if (!raw) return res.status(404).json({ error: 'Match not found or expired.' });
  const match = JSON.parse(raw);

  const me = match.players[role];
  if (!me || me.token !== token) return res.status(403).json({ error: 'Invalid credentials for this match.' });

  return res.status(200).json(publicView(match));
}
