// Public matchmaking. If someone else is waiting, pairs immediately.
// Otherwise joins the queue and the caller polls /api/pvp-quick-status.
import { randomUUID } from 'node:crypto';

const URL = process.env.KV_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN;
const MAX_ENTRY_AGE_MS = 90 * 1000;

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
  if (!URL || !TOKEN) return res.status(500).json({ error: 'Server is missing KV_REST_API_URL / KV_REST_API_TOKEN.' });

  const { name, card } = req.body || {};
  if (!card || !card.stats) return res.status(400).json({ error: 'Missing card.' });

  // Try to find a valid (non-stale) waiting opponent.
  let opponent = null;
  for (let i = 0; i < 5; i++) {
    const raw = await redis(['LPOP', 'queue:public']);
    if (!raw) break;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.createdAt <= MAX_ENTRY_AGE_MS) {
      opponent = entry;
      break;
    }
    // stale entry — discard and keep looking
  }

  if (opponent) {
    const matchId = randomUUID();
    const myToken = randomUUID();
    const turn = card.stats.SPD >= opponent.card.stats.SPD ? 'p2' : 'p1';

    const match = {
      id: matchId,
      code: null,
      status: 'active',
      createdAt: Date.now(),
      turn,
      winner: null,
      log: [
        'Quick match found!',
        (turn === 'p1' ? opponent.name : (name || 'Player')) + ' is faster and goes first.'
      ],
      players: {
        p1: { token: opponent.token, name: opponent.name, card: opponent.card, hp: opponent.card.stats.HP, maxHp: opponent.card.stats.HP, defending: false },
        p2: { token: myToken, name: name || 'Player', card, hp: card.stats.HP, maxHp: card.stats.HP, defending: false }
      }
    };

    await redis(['SET', 'match:' + matchId, JSON.stringify(match), 'EX', 1800]);
    await redis(['SET', 'ticket:' + opponent.ticket, JSON.stringify({ matchId, role: 'p1', token: opponent.token }), 'EX', 120]);

    return res.status(200).json({ matched: true, matchId, role: 'p2', token: myToken });
  }

  // No one waiting — join the queue ourselves.
  const ticket = randomUUID();
  const myToken = randomUUID();
  await redis(['RPUSH', 'queue:public', JSON.stringify({ ticket, token: myToken, name: name || 'Player', card, createdAt: Date.now() })]);

  return res.status(200).json({ matched: false, ticket, token: myToken });
}
