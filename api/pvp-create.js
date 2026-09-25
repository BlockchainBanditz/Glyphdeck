// Creates a PvP room. Returns a 6-char code the creator shares with a friend.
import { randomUUID } from 'node:crypto';

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

function makeCode() {
  return randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!URL || !TOKEN) return res.status(500).json({ error: 'Server is missing KV_REST_API_URL / KV_REST_API_TOKEN.' });

  const { name, address, card } = req.body || {};
  if (!card || !card.stats) return res.status(400).json({ error: 'Missing card.' });

  const matchId = randomUUID();
  const token = randomUUID();
  const code = makeCode();

  const match = {
    id: matchId,
    code,
    status: 'waiting',
    createdAt: Date.now(),
    turn: null,
    winner: null,
    log: ['Room created. Waiting for an opponent to join with code ' + code + '.'],
    players: {
      p1: { token, name: name || 'Player 1', address: address || null, card, hp: card.stats.HP, maxHp: card.stats.HP, defending: false },
      p2: null
    }
  };

  await redis(['SET', 'match:' + matchId, JSON.stringify(match), 'EX', 1800]);
  await redis(['SET', 'code:' + code, matchId, 'EX', 1800]);

  return res.status(200).json({ matchId, code, role: 'p1', token });
}
