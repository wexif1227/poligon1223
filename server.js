/**
 * Poligon multiplayer server — v2
 * Render: Web Service, Start: node server.js, Health: /health
 */
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = 6;
const MAX_NAME_LEN = 18;
const MAX_ROOM_LEN = 12;
const MAX_POS = 500;
const MAX_DAMAGE = 100;
const MIN_DAMAGE = 1;
const STATE_MIN_INTERVAL_MS = 30;
const SPAWN_PROTECTION_MS = 3000;
const HEARTBEAT_MS = 25000;

const SPAWN_POINTS = [
  { x: -16, y: 1.6, z: -22 },
  { x:  16, y: 1.6, z: -22 },
  { x: -18, y: 1.6, z:  20 },
  { x:  18, y: 1.6, z:  20 },
  { x:   0, y: 1.6, z:  24 }
];

const rooms = new Map();
const clampNum = (v, min, max, fb = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
};
const sanitizeName = (v, fb = 'Игрок') => {
  const s = String(v ?? fb).replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_NAME_LEN);
  return s || fb;
};
const sanitizeRoom = (v) => {
  const s = String(v ?? 'LOBBY').toUpperCase().replace(/[^A-Z0-9_\-]/g, '').slice(0, MAX_ROOM_LEN);
  return s || 'LOBBY';
};
const sanitizeId = (v) => String(v ?? '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 24);

function roomOf(code) {
  const key = sanitizeRoom(code);
  if (!rooms.has(key)) rooms.set(key, new Map());
  return { key, players: rooms.get(key) };
}
function publicPlayer(p) {
  return {
    id: p.id, name: p.name,
    x: p.x, y: p.y, z: p.z,
    yaw: p.yaw, pitch: p.pitch,
    weapon: p.weapon, model: p.model,
    hp: p.hp, godMode: !!p.godMode, crouched: !!p.crouched,
    kills: p.kills, deaths: p.deaths
  };
}
function roster(key) {
  const players = rooms.get(key);
  return players ? [...players.values()].map(publicPlayer) : [];
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(key, obj, exceptId = null) {
  const players = rooms.get(key);
  if (!players) return;
  const raw = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws && p.ws.readyState === 1) p.ws.send(raw);
  }
}
function pickSpawn() {
  const s = SPAWN_POINTS[(Math.random() * SPAWN_POINTS.length) | 0];
  return {
    x: s.x + (Math.random() - 0.5) * 1.2,
    y: s.y,
    z: s.z + (Math.random() - 0.5) * 1.2
  };
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('OK'); return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });
let nextId = 1;

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let me = null;
  let lastStateAt = 0;

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'ping') { send(ws, { type: 'pong', t: m.t }); return; }

    if (m.type === 'join') {
      const { key, players } = roomOf(m.room);
      if (players.size >= MAX_PER_ROOM) {
        send(ws, { type: 'error', message: 'Комната полная (макс 6)' });
        try { ws.close(4000, 'room full'); } catch {}
        return;
      }
      if (me) players.delete(me.id);
      const id = String(nextId++);
      const spawn = pickSpawn();
      me = {
        id, ws, room: key,
        name: sanitizeName(m.name),
        x: spawn.x, y: spawn.y, z: spawn.z,
        yaw: 0, pitch: 0, weapon: 'ak47',
        model: sanitizeId(m.model) || 'chicken',
        hp: 100, godMode: false, crouched: false,
        kills: 0, deaths: 0,
        spawnShieldUntil: Date.now() + SPAWN_PROTECTION_MS
      };
      players.set(id, me);
      send(ws, {
        type: 'welcome', id, room: key,
        mode: 'bots', map: 'arena',
        spawnShieldMs: SPAWN_PROTECTION_MS,
        players: roster(key)
      });
      broadcast(key, { type: 'players', players: roster(key) }, id);
      broadcast(key, { type: 'notice', message: me.name + ' вошёл в комнату' });
      return;
    }

    if (!me) return;
    const players = rooms.get(me.room);
    if (!players || !players.has(me.id)) return;

    switch (m.type) {
      case 'state': {
        const now = Date.now();
        if (now - lastStateAt < STATE_MIN_INTERVAL_MS) return;
        lastStateAt = now;
        me.x = clampNum(m.x, -MAX_POS, MAX_POS, me.x);
        me.y = clampNum(m.y, -MAX_POS, MAX_POS, me.y);
        me.z = clampNum(m.z, -MAX_POS, MAX_POS, me.z);
        me.yaw = clampNum(m.yaw, -Math.PI * 2, Math.PI * 2, me.yaw);
        me.pitch = clampNum(m.pitch, -2, 2, me.pitch);
        if (typeof m.weapon === 'string') me.weapon = m.weapon.slice(0, 16);
        if (typeof m.model === 'string') me.model = sanitizeId(m.model) || me.model;
        if (typeof m.crouched === 'boolean') me.crouched = m.crouched;
        if (typeof m.godMode === 'boolean') me.godMode = m.godMode;
        broadcast(me.room, {
          type: 'state', id: me.id,
          x: me.x, y: me.y, z: me.z,
          yaw: me.yaw, pitch: me.pitch,
          weapon: me.weapon, model: me.model,
          hp: me.hp, godMode: me.godMode, crouched: me.crouched
        }, me.id);
        break;
      }
      case 'characterModel':
        me.model = sanitizeId(m.model) || me.model;
        broadcast(me.room, {
          type: 'state', id: me.id,
          x: me.x, y: me.y, z: me.z,
          yaw: me.yaw, pitch: me.pitch,
          weapon: me.weapon, model: me.model,
          hp: me.hp, godMode: me.godMode, crouched: me.crouched
        }, me.id);
        break;
      case 'shot':
        broadcast(me.room, { type: 'shot', id: me.id, weapon: m.weapon || me.weapon }, me.id);
        break;
      case 'weaponAction':
        if (typeof m.action === 'string' && m.action.length < 24)
          broadcast(me.room, { type: 'weaponAction', id: me.id, weapon: me.weapon, action: m.action }, me.id);
        break;
      case 'hit': {
        const targetId = sanitizeId(m.target);
        const target = players.get(targetId);
        if (!target || target.id === me.id) break;
        if (target.godMode) target.hp = 100;
        else if (target.spawnShieldUntil && Date.now() < target.spawnShieldUntil) {}
        else {
          const dmg = clampNum(m.damage, MIN_DAMAGE, MAX_DAMAGE, 34);
          target.hp = Math.max(0, target.hp - dmg);
        }
        broadcast(me.room, {
          type: 'hit', target: target.id, killer: me.id,
          name: me.name, hp: target.hp, damage: m.damage
        });
        if (target.hp <= 0) {
          me.kills++; target.deaths++;
          broadcast(me.room, {
            type: 'kill', killer: me.id, killerName: me.name,
            victim: target.id, victimName: target.name, weapon: me.weapon
          });
          const sp = pickSpawn();
          target.x = sp.x; target.y = sp.y; target.z = sp.z;
          target.hp = 100;
          target.spawnShieldUntil = Date.now() + SPAWN_PROTECTION_MS;
          send(target.ws, {
            type: 'state', id: target.id,
            x: target.x, y: target.y, z: target.z,
            yaw: target.yaw, pitch: target.pitch,
            weapon: target.weapon, model: target.model,
            hp: 100, godMode: target.godMode, crouched: false,
            spawnShieldMs: SPAWN_PROTECTION_MS
          });
          broadcast(me.room, { type: 'players', players: roster(me.room) });
        }
        break;
      }
      case 'respawn': {
        const sp = pickSpawn();
        me.x = sp.x; me.y = sp.y; me.z = sp.z;
        me.hp = 100;
        me.spawnShieldUntil = Date.now() + SPAWN_PROTECTION_MS;
        send(ws, {
          type: 'state', id: me.id,
          x: me.x, y: me.y, z: me.z,
          yaw: me.yaw, pitch: me.pitch,
          weapon: me.weapon, model: me.model,
          hp: 100, godMode: me.godMode, crouched: false,
          spawnShieldMs: SPAWN_PROTECTION_MS
        });
        broadcast(me.room, { type: 'players', players: roster(me.room) }, me.id);
        break;
      }
      case 'mode':
        if (typeof m.mode === 'string') broadcast(me.room, { type: 'mode', mode: m.mode.slice(0, 16) });
        break;
      case 'map':
        if (typeof m.map === 'string') broadcast(me.room, { type: 'map', map: m.map.slice(0, 32) });
        break;
    }
  });

  ws.on('close', () => {
    if (!me) return;
    const players = rooms.get(me.room);
    if (players) {
      players.delete(me.id);
      broadcast(me.room, { type: 'players', players: roster(me.room) });
      broadcast(me.room, { type: 'notice', message: me.name + ' вышел' });
      if (players.size === 0) rooms.delete(me.room);
    }
    me = null;
  });
  ws.on('error', () => { try { ws.close(); } catch {} });
});

const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);
hb.unref();

function shutdown(sig) {
  console.log('Shutting down', sig);
  clearInterval(hb);
  try { wss.close(); } catch {}
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => console.log('Poligon MP v2 on port', PORT));