// Joins a PvP room using its code, starts the match.
import { randomUUID } from 'node:crypto';

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!URL || !TOKEN) return res.status(500).json({ error: 'Server is missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.' });

  const { code, name, card } = req.body || {};
  if (!code || !card || !card.stats) return res.status(400).json({ error: 'Missing code or card.' });

  const matchId = await redis(['GET', 'code:' + code.toUpperCase()]);
  if (!matchId) return res.status(404).json({ error: 'No room found for that code (it may have expired).' });

  const raw = await redis(['GET', 'match:' + matchId]);
  if (!raw) return res.status(404).json({ error: 'That room has expired.' });
  const match = JSON.parse(raw);

  if (match.status !== 'waiting' || match.players.p2) {
    return res.status(409).json({ error: 'That room is already full.' });
  }

  const token = randomUUID();
  match.players.p2 = { token, name: name || 'Player 2', card, hp: card.stats.HP, maxHp: card.stats.HP, defending: false };
  match.status = 'active';
  match.turn = card.stats.SPD >= match.players.p1.card.stats.SPD ? 'p2' : 'p1';
  match.log.push((name || 'Player 2') + ' joined the room.');
  match.log.push((match.turn === 'p1' ? match.players.p1.name : match.players.p2.name) + ' is faster and goes first.');

  await redis(['SET', 'match:' + matchId, JSON.stringify(match), 'EX', 1800]);

  return res.status(200).json({ matchId, role: 'p2', token });
}
