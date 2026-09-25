// Submits a move. Server computes the result so both players see the same outcome.
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

function damageRoll(atk, defenderDefending, def) {
  const effectiveDef = defenderDefending ? def * 1.8 : def;
  let dmg = atk - Math.floor(effectiveDef / 2);
  dmg = Math.max(1, dmg);
  const variance = 0.85 + Math.random() * 0.3;
  return Math.max(1, Math.round(dmg * variance));
}

function currentMonthKey() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!URL || !TOKEN) return res.status(500).json({ error: 'Server is missing KV_REST_API_URL / KV_REST_API_TOKEN.' });

  const { matchId, role, token, action } = req.body || {};
  if (!matchId || !role || !token || !['attack', 'defend'].includes(action)) {
    return res.status(400).json({ error: 'Missing or invalid matchId, role, token, or action.' });
  }

  const raw = await redis(['GET', 'match:' + matchId]);
  if (!raw) return res.status(404).json({ error: 'Match not found or expired.' });
  const match = JSON.parse(raw);

  const me = match.players[role];
  const otherRole = role === 'p1' ? 'p2' : 'p1';
  const opp = match.players[otherRole];

  if (!me || me.token !== token) return res.status(403).json({ error: 'Invalid credentials for this match.' });
  if (match.status !== 'active') return res.status(409).json({ error: 'Match is not active.' });
  if (match.turn !== role) return res.status(409).json({ error: "It's not your turn yet." });

  if (action === 'attack') {
    const dmg = damageRoll(me.card.stats.ATK, opp.defending, opp.card.stats.DEF);
    opp.hp -= dmg;
    me.defending = false;
    match.log.push(me.name + ' attacks for ' + dmg + ' damage.');
  } else {
    me.defending = true;
    match.log.push(me.name + ' braces to defend.');
  }

  if (opp.hp <= 0) {
    opp.hp = 0;
    match.status = 'finished';
    match.winner = role;
    match.log.push(me.name + ' wins the duel!');
    if (me.address) {
      const lbKey = 'leaderboard:pvp:' + currentMonthKey();
      try {
        await redis(['ZINCRBY', lbKey, '1', me.address.toLowerCase()]);
        await redis(['EXPIRE', lbKey, '3456000']);
      } catch (e) {
        // Leaderboard write failing shouldn't break the match result itself.
      }
    }
  } else {
    match.turn = otherRole;
  }

  await redis(['SET', 'match:' + matchId, JSON.stringify(match), 'EX', 1800]);

  return res.status(200).json(publicView(match));
}
