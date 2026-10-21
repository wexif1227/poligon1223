/**
 * Poligon multiplayer server — compatible with HTML and Unity clients.
 * Deploy on Render: Web Service, start command `node server.js`
 * Protocol: JSON over WebSocket, max 6 players per room.
 */
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = 6;

const roomSettings = new Map();
const maps = new Set(['mirage', 'sandstone', 'rust', 'arena', 'province', 'zone9']);
const characterModels = new Set(['chicken', 'anime3d', 'anime1', 'anime2', 'anime3', 'annie', 'bikini', 'elf']);
const emotes = new Set(['orange', 'floss', 'shuffle', 'robot']);
const activeGrenades = new Map();
const grenadeKinds = new Set(['he', 'flash', 'smoke', 'molotov']);
const validPosition = m => ['x', 'y', 'z'].every(k => Number.isFinite(m[k]) && Math.abs(m[k]) <= 1000);
// Expire lost throws without trusting unbounded client-owned state.
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, g] of activeGrenades) if (now - g.created > 15000) activeGrenades.delete(key);
}, 5000);
cleanup.unref();
const rooms = new Map(); // roomCode -> Map(id -> player)

function roomOf(code) {
  const key = String(code || 'LOBBY').toUpperCase().slice(0, 12);
  if (!rooms.has(key)) rooms.set(key, new Map());
  return { key, players: rooms.get(key) };
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    x: p.x, y: p.y, z: p.z,
    yaw: p.yaw, pitch: p.pitch,
    weapon: p.weapon,
    hp: p.hp,
    godMode: !!p.godMode,
    model: p.model,
    crouched: !!p.crouched,
    grounded: !!p.grounded,
    hasAnimationState: !!p.hasAnimationState,
    emote: p.emote || '',
    emoteTime: emoteTime(p)
  };
}

function emoteTime(p) {
  return p.emote ? Math.max(0, Math.min(86400, (Date.now() - p.emoteStartedAt) / 1000)) : 0;
}

function setEmote(p, id, elapsed) {
  p.emote = emotes.has(id) ? id : '';
  const time = Number.isFinite(elapsed) ? Math.max(0, Math.min(86400, elapsed)) : 0;
  p.emoteStartedAt = p.emote ? Date.now() - time * 1000 : 0;
}

function stopEmote(p) {
  if (!p.emote) return;
  setEmote(p, '', 0);
  broadcast(p.room, { type: 'emote', id: p.id, emote: '', emoteTime: 0 });
}

function broadcast(roomKey, obj, exceptId = null) {
  const players = rooms.get(roomKey);
  if (!players) return;
  const raw = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws && p.ws.readyState === 1) p.ws.send(raw);
  }
}

function roster(roomKey) {
  const players = rooms.get(roomKey);
  if (!players) return [];
  return [...players.values()].map(publicPlayer);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Poligon MP server OK\n');
});

const wss = new WebSocketServer({ server, maxPayload: 16384 });

let nextId = 1;

wss.on('connection', (ws) => {
  let me = null;

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'join') {
      if (me) return;
      const { key, players } = roomOf(m.room);
      if (players.size >= MAX_PER_ROOM) {
        ws.send(JSON.stringify({ type: 'error', message: 'Комната полная (макс 6)' }));
        return;
      }
      if (!roomSettings.has(key)) roomSettings.set(key, { map: maps.has(m.map) ? m.map : 'mirage', mode: 'bots' });
      const settings = roomSettings.get(key);
      const id = String(nextId++);
      me = {
        id, ws, room: key,
        name: String(m.name || 'Игрок').slice(0, 18),
        x: 0, y: 1.6, z: 8, yaw: 0, pitch: 0,
        weapon: 'ak47', hp: 100, godMode: false,
        model: characterModels.has(m.model) ? m.model : 'chicken',
        crouched: false, grounded: true, hasAnimationState: false,
        emote: '', emoteStartedAt: 0,
        kills: 0, deaths: 0
      };
      players.set(id, me);
      ws.send(JSON.stringify({
        type: 'welcome',
        id,
        room: key,
        players: roster(key),
        mode: settings.mode,
        map: settings.map
      }));
      broadcast(key, { type: 'players', players: roster(key) }, id);
      broadcast(key, { type: 'notice', message: me.name + ' вошёл в комнату' });
      return;
    }

    if (!me) return;
    const players = rooms.get(me.room);
    if (!players) return;

    switch (m.type) {
      case 'state':
        me.x = +m.x || 0; me.y = +m.y || 0; me.z = +m.z || 0;
        me.yaw = +m.yaw || 0; me.pitch = +m.pitch || 0;
        if (m.weapon) me.weapon = String(m.weapon);
        me.godMode = !!m.godMode;
        if (characterModels.has(m.model)) me.model = m.model;
        me.crouched = m.crouched === true;
        me.hasAnimationState = m.hasAnimationState === true && typeof m.grounded === 'boolean';
        me.grounded = me.hasAnimationState ? m.grounded : true;
        if (typeof m.emote === 'string') setEmote(me, m.emote, m.emoteTime);
        if (me.crouched || !me.grounded) setEmote(me, '', 0);
        if (typeof m.hp === 'number') me.hp = m.hp;
        broadcast(me.room, {
          type: 'state',
          id: me.id,
          x: me.x, y: me.y, z: me.z,
          yaw: me.yaw, pitch: me.pitch,
          weapon: me.weapon, hp: me.hp, godMode: me.godMode,
          model: me.model, crouched: me.crouched,
          grounded: me.grounded, hasAnimationState: me.hasAnimationState,
          emote: me.emote, emoteTime: emoteTime(me)
        }, me.id);
        break;

      case 'emote':
        if (m.emote !== '' && !emotes.has(m.emote)) break;
        setEmote(me, m.emote, m.emoteTime);
        broadcast(me.room, { type: 'emote', id: me.id, emote: me.emote, emoteTime: emoteTime(me) }, me.id);
        break;

      case 'characterModel':
        if (!characterModels.has(m.model)) break;
        stopEmote(me);
        me.model = m.model;
        broadcast(me.room, { type: 'players', players: roster(me.room) });
        break;

      case 'grenadeThrow': {
        if (typeof m.gid !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(m.gid) ||
            !grenadeKinds.has(m.kind) || !validPosition(m) ||
            !['vx', 'vy', 'vz'].every(k => Number.isFinite(m[k]) && Math.abs(m[k]) <= 100)) break;
        const now = Date.now();
        if (now - (me.lastGrenade || 0) < 300) break;
        const key = me.room + ':' + m.gid;
        if (activeGrenades.has(key)) break;
        me.lastGrenade = now;
        stopEmote(me);
        activeGrenades.set(key, { owner: me.id, room: me.room, kind: m.kind, created: now });
        broadcast(me.room, { type: 'grenadeThrow', id: me.id, gid: m.gid, kind: m.kind,
          x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz }, me.id);
        break;
      }
      case 'grenadeDet': {
        const key = me.room + ':' + m.gid;
        const g = activeGrenades.get(key);
        if (!g || g.owner !== me.id || g.detonated || !validPosition(m) || Date.now() - g.created > 15000) break;
        g.detonated = true;
        broadcast(me.room, { type: 'grenadeDet', id: me.id, gid: m.gid, kind: g.kind,
          x: m.x, y: m.y, z: m.z }, me.id);
        break;
      }
      case 'weaponAction':
        if (['reload_start', 'inspect_start', 'melee'].includes(m.action)) stopEmote(me);
        if (typeof m.action === 'string')
          broadcast(me.room, { type: 'weaponAction', id: me.id, weapon: me.weapon, action: m.action.slice(0, 64) }, me.id);
        break;
      case 'shot':
        stopEmote(me);
        broadcast(me.room, { type: 'shot', id: me.id, weapon: m.weapon || me.weapon }, me.id);
        break;

      case 'hit': {
        const target = players.get(String(m.target));
        if (!target) break;
        if (target.godMode) {
          target.hp = 100;
        } else {
          stopEmote(target);
          const dmg = Math.max(1, Math.min(100, +m.damage || 34));
          target.hp = Math.max(0, target.hp - dmg);
        }
        const payload = {
          type: 'hit',
          target: target.id,
          killer: me.id,
          name: me.name,
          hp: target.hp,
          damage: m.damage
        };
        // send to everyone including attacker & victim
        const raw = JSON.stringify(payload);
        for (const p of players.values()) {
          if (p.ws && p.ws.readyState === 1) p.ws.send(raw);
        }
        if (target.hp <= 0) {
          me.kills++;
          target.deaths++;
          target.hp = 100;
          broadcast(me.room, { type: 'notice', message: me.name + ' убил ' + target.name });
        }
        break;
      }

      case 'respawn':
        stopEmote(me);
        me.hp = 100;
        me.crouched = false;
        me.grounded = false;
        me.x = 0; me.y = 1.6; me.z = 8;
        broadcast(me.room, { type: 'players', players: roster(me.room) });
        break;

      case 'mode':
        if (typeof m.mode !== 'string') break;
        roomSettings.get(me.room).mode = m.mode.slice(0, 32);
        broadcast(me.room, { type: 'mode', mode: m.mode });
        break;

      case 'map':
        if (!maps.has(m.map)) break;
        roomSettings.get(me.room).map = m.map;
        for (const player of players.values()) stopEmote(player);
        for (const [key, g] of activeGrenades) if (g.room === me.room) activeGrenades.delete(key);
        broadcast(me.room, { type: 'map', map: m.map });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (!me) return;
    for (const [key, g] of activeGrenades) if (g.owner === me.id) activeGrenades.delete(key);
    const players = rooms.get(me.room);
    if (players) {
      players.delete(me.id);
      broadcast(me.room, { type: 'players', players: roster(me.room) });
      broadcast(me.room, { type: 'notice', message: me.name + ' вышел' });
      if (players.size === 0) { rooms.delete(me.room); roomSettings.delete(me.room); }
    }
    me = null;
  });
});

server.listen(PORT, () => {
  console.log('Poligon MP on port', server.address().port);
});
