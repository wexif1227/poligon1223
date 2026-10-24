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
const emotes = new Set(['orange', 'floss', 'shuffle', 'robot', 'takel', 'bestmates', 'electro', 'dab', 'wave', 'facepalm', 'laugh', 'cheer']);
const teams = new Set(['t', 'ct']);
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

// ---- round mode (server-authoritative) ----
const ROUND_SITES = {
  mirage: [[-15, -46], [-24, 40]],
  sandstone: [[43, 25], [-43, 17]],
  rust: [[0, 46], [0, -45]],
  province: [[0, 40], [0, -40]],
  zone9: [[0, 46], [0, -45]],
  arena: [[40, 0], [-40, 0]]
};
const ROUND_BUY_MS = 15000;
const ROUND_LIVE_MS = 115000;
const ROUND_BOMB_MS = 40000;
const ROUND_END_MS = 5000;
const ROUND_HALF_MS = 8000;
const ROUND_MATCH_MS = 12000;
const roundRooms = new Map();

function otherTeam(t) { return t === 'ct' ? 't' : 'ct'; }
function sitesFor(map) { return ROUND_SITES[map] || ROUND_SITES.mirage; }
function nearSite(map, x, z) {
  const list = sitesFor(map);
  for (let i = 0; i < list.length; i++) {
    const dx = x - list[i][0], dz = z - list[i][1];
    if (dx * dx + dz * dz <= 14 * 14) return i;
  }
  return -1;
}
function teamAlive(players, team) {
  let n = 0;
  for (const p of players.values()) if (p.team === team && p.hp > 0) n++;
  return n;
}
function resetRoundPlayers(players) {
  for (const p of players.values()) { p.hp = 100; p.crouched = false; p.grounded = true; }
}
function roundPayload(settings) {
  const st = settings.round;
  const now = Date.now();
  return {
    type: 'round',
    phase: st.phase,
    round: st.round,
    scoreCT: st.ct,
    scoreT: st.t,
    timeLeft: Math.max(0, Math.round((st.ends - now) / 1000)),
    roundStart: false,
    bombPlanted: !!st.bomb,
    bombSite: st.bomb ? st.bomb.site : -1,
    bombTime: st.bomb ? Math.max(0, Math.round((st.bomb.ends - now) / 1000)) : 0,
    aliveCT: teamAlive(rooms.get(settings.key) || new Map(), 'ct'),
    aliveT: teamAlive(rooms.get(settings.key) || new Map(), 't'),
    winner: st.winner || '',
    reason: st.reason || '',
    matchOver: !!st.matchOver
  };
}
function sendRound(key, settings, roundStart = false) {
  const players = rooms.get(key);
  if (!players) return;
  const base = roundPayload(settings);
  base.roundStart = roundStart;
  for (const p of players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const payload = Object.assign({}, base, { team: p.team });
    p.ws.send(JSON.stringify(payload));
  }
}
function startRound(key, settings, roundStart = true) {
  const players = rooms.get(key);
  if (!players) return;
  resetRoundPlayers(players);
  startRoundPhaseBuy(key, settings, roundStart);
}
function startRoundPhaseBuy(key, settings, roundStart = true) {
  const st = settings.round;
  st.phase = 'buy';
  st.ends = Date.now() + ROUND_BUY_MS;
  st.bomb = null;
  st.winner = '';
  st.reason = '';
  st.hadCT = teamAlive(rooms.get(key) || new Map(), 'ct');
  st.hadT = teamAlive(rooms.get(key) || new Map(), 't');
  sendRound(key, settings, roundStart);
}
function startRoundPhaseLive(key, settings) {
  const st = settings.round;
  st.phase = 'live';
  st.ends = Date.now() + ROUND_LIVE_MS;
  st.hadCT = teamAlive(rooms.get(key) || new Map(), 'ct');
  st.hadT = teamAlive(rooms.get(key) || new Map(), 't');
  sendRound(key, settings, false);
}
function endRound(key, settings, winner, reason) {
  const st = settings.round;
  if (!st || st.phase !== 'live') return;
  st.phase = 'roundEnd';
  st.ends = Date.now() + ROUND_END_MS;
  st.winner = winner;
  st.reason = reason;
  if (winner === 'ct') st.ct++; else st.t++;
  if (st.ct >= st.target || st.t >= st.target) st.matchOver = true;
  st.bomb = null;
  sendRound(key, settings, false);
}
function beginRounds(key, settings) {
  settings.round = {
    key, phase: 'warmup', ends: Date.now() + 8000,
    round: 1, ct: 0, t: 0, target: 13,
    bomb: null, winner: '', reason: '',
    sideSwapped: false, matchOver: false, hadCT: 0, hadT: 0
  };
  resetRoundPlayers(rooms.get(key) || new Map());
  sendRound(key, settings, false);
}
function nextRoundOrHalf(key, settings) {
  const st = settings.round;
  if (!st) return;
  if (st.matchOver) {
    st.phase = 'matchEnd';
    st.ends = Date.now() + ROUND_MATCH_MS;
    sendRound(key, settings, false);
    return;
  }
  if (st.round >= 12 && !st.sideSwapped) {
    st.sideSwapped = true;
    st.phase = 'halftime';
    st.ends = Date.now() + ROUND_HALF_MS;
    sendRound(key, settings, false);
    return;
  }
  st.round++;
  startRound(key, settings, true);
}
function tickRound(key, settings) {
  const st = settings.round;
  if (!st) return;
  const players = rooms.get(key);
  if (!players) { roundRooms.delete(key); return; }
  const now = Date.now();
  switch (st.phase) {
    case 'warmup':
      if (now >= st.ends) startRoundPhaseBuy(key, settings, true);
      break;
    case 'buy':
      if (now >= st.ends) startRoundPhaseLive(key, settings);
      break;
    case 'live': {
      if (st.bomb) {
        if (now >= st.bomb.ends) endRound(key, settings, 't', 'бомба взорвалась');
      } else {
        const ct = teamAlive(players, 'ct'), t = teamAlive(players, 't');
        if (st.hadT > 0 && t === 0 && ct > 0) endRound(key, settings, 'ct', 'все T устранены');
        else if (st.hadCT > 0 && ct === 0 && t > 0) endRound(key, settings, 't', 'все CT устранены');
        else if (now >= st.ends) endRound(key, settings, 'ct', 'время вышло, бомба не установлена');
      }
      break;
    }
    case 'roundEnd':
      if (now >= st.ends) nextRoundOrHalf(key, settings);
      break;
    case 'halftime':
      if (now >= st.ends) {
        for (const p of players.values()) p.team = otherTeam(p.team);
        resetRoundPlayers(players);
        broadcast(key, { type: 'players', players: roster(key) });
        st.round++;
        startRound(key, settings, true);
      }
      break;
    case 'matchEnd':
      if (now >= st.ends) beginRounds(key, settings);
      break;
  }
  if (settings.round === st) sendRound(key, settings, false);
}
setInterval(() => {
  for (const [key, settings] of roomSettings) {
    if (settings.mode === 'rounds' && settings.round) tickRound(key, settings);
  }
}, 400).unref();


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
    emoteTime: emoteTime(p),
    team: p.team || 't',
    kills: p.kills || 0,
    deaths: p.deaths || 0
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
      if (!roomSettings.has(key)) roomSettings.set(key, {
        map: maps.has(m.map) ? m.map : 'mirage',
        mode: m.mode === 'rounds' ? 'rounds' : 'bots'
      });
      const settings = roomSettings.get(key);
      if (m.mode === 'rounds' && settings.mode !== 'rounds') {
        settings.mode = 'rounds';
        settings.round = null;
      }
      const id = String(nextId++);
      let team = teams.has(m.team) ? m.team : '';
      if (!team) {
        let tCount = 0, ctCount = 0;
        for (const p of players.values()) (p.team === 'ct' ? ctCount++ : tCount++);
        team = tCount <= ctCount ? 't' : 'ct';
      }
      me = {
        id, ws, room: key,
        name: String(m.name || 'Игрок').slice(0, 18),
        team,
        x: 0, y: 1.6, z: 8, yaw: 0, pitch: 0,
        weapon: 'ak47', hp: 100, godMode: false,
        model: characterModels.has(m.model) ? m.model : 'chicken',
        crouched: false, grounded: true, hasAnimationState: false,
        emote: '', emoteStartedAt: 0,
        kills: 0, deaths: 0
      };
      players.set(id, me);
      if (settings.mode === 'rounds' && !settings.round) beginRounds(key, settings);
      ws.send(JSON.stringify({
        type: 'welcome',
        id,
        room: key,
        players: roster(key),
        mode: settings.mode,
        map: settings.map,
        team
      }));
      broadcast(key, { type: 'players', players: roster(key) }, id);
      broadcast(key, { type: 'notice', message: me.name + ' вошёл в комнату' });
      if (settings.mode === 'rounds') sendRound(key, settings, false);
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
        const stateSettings = roomSettings.get(me.room);
        if (stateSettings && stateSettings.mode === 'rounds' && stateSettings.round) {
          if (!(stateSettings.round.phase === 'live' && me.hp <= 0) && typeof m.hp === 'number') me.hp = m.hp;
        } else if (typeof m.hp === 'number') me.hp = m.hp;
        broadcast(me.room, {
          type: 'state',
          id: me.id,
          x: me.x, y: me.y, z: me.z,
          yaw: me.yaw, pitch: me.pitch,
          weapon: me.weapon, hp: me.hp, godMode: me.godMode,
          model: me.model, crouched: me.crouched,
          grounded: me.grounded, hasAnimationState: me.hasAnimationState,
          emote: me.emote, emoteTime: emoteTime(me),
          team: me.team,
          kills: me.kills, deaths: me.deaths
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
        if (target.team && me.team && target.team === me.team) break;
        const hitSettings = roomSettings.get(me.room);
        const hitRound = hitSettings && hitSettings.round;
        if (hitSettings && hitSettings.mode === 'rounds') {
          if (!hitRound || hitRound.phase !== 'live' || target.hp <= 0 || me.hp <= 0) break;
          const dmg = Math.max(1, Math.min(100, +m.damage || 34));
          if (!target.godMode) target.hp = Math.max(0, target.hp - dmg);
          const payload = { type: 'hit', target: target.id, killer: me.id, name: me.name, hp: target.hp, damage: m.damage };
          const raw = JSON.stringify(payload);
          for (const p of players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(raw);
          if (target.hp <= 0) {
            me.kills++; target.deaths++; target.hp = 0;
            broadcast(me.room, { type: 'kill', killerName: me.name, victimName: target.name, weapon: me.weapon });
            broadcast(me.room, { type: 'notice', message: me.name + ' убил ' + target.name });
            sendRound(me.room, hitSettings, false);
          }
          break;
        }
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
          broadcast(me.room, {
            type: 'kill',
            killerName: me.name,
            victimName: target.name,
            weapon: me.weapon
          });
          broadcast(me.room, { type: 'notice', message: me.name + ' убил ' + target.name });
        }
        break;
      }

      case 'plant': {
        const settings = roomSettings.get(me.room);
        const st = settings && settings.round;
        if (!st || st.phase !== 'live' || st.bomb || me.team !== 't' || me.hp <= 0) break;
        if (!Number.isFinite(+m.x) || !Number.isFinite(+m.z)) break;
        const site = nearSite(settings.map, +m.x, +m.z);
        if (site < 0) break;
        st.bomb = { site, ends: Date.now() + ROUND_BOMB_MS, by: me.id };
        sendRound(me.room, settings, false);
        break;
      }
      case 'defuse': {
        const settings = roomSettings.get(me.room);
        const st = settings && settings.round;
        if (!st || st.phase !== 'live' || !st.bomb || me.team !== 'ct' || me.hp <= 0) break;
        const site = sitesFor(settings.map)[st.bomb.site];
        if (!site) break;
        const dx = (+m.x || 0) - site[0], dz = (+m.z || 0) - site[1];
        if (dx * dx + dz * dz > 8 * 8) break;
        st.bomb = null;
        endRound(me.room, settings, 'ct', 'бомба разминирована');
        break;
      }
      case 'respawn': {
        const settings = roomSettings.get(me.room);
        const st = settings && settings.round;
        if (settings && settings.mode === 'rounds' && st && st.phase !== 'buy' && st.phase !== 'warmup') break;
        stopEmote(me);
        me.hp = 100;
        me.crouched = false;
        me.grounded = false;
        // The client picks a spawn from its team's list and reports it in the next state.
        broadcast(me.room, { type: 'players', players: roster(me.room) });
        break;
      }

      case 'team': {
        const settings = roomSettings.get(me.room);
        const st = settings && settings.round;
        if (settings && settings.mode === 'rounds' && st && st.phase !== 'buy' && st.phase !== 'warmup') break;
        if (!teams.has(m.team) || me.team === m.team) break;
        stopEmote(me);
        me.team = m.team;
        me.hp = 100;
        broadcast(me.room, { type: 'players', players: roster(me.room) });
        break;
      }

      case 'mode': {
        if (typeof m.mode !== 'string') break;
        const settings = roomSettings.get(me.room);
        settings.mode = m.mode.slice(0, 32);
        if (settings.mode === 'rounds') {
          if (!settings.round) beginRounds(me.room, settings);
          else sendRound(me.room, settings, false);
        } else {
          settings.round = null;
        }
        broadcast(me.room, { type: 'mode', mode: settings.mode });
        break;
      }

      case 'map': {
        if (!maps.has(m.map)) break;
        const settings = roomSettings.get(me.room);
        settings.map = m.map;
        for (const player of players.values()) stopEmote(player);
        for (const [key, g] of activeGrenades) if (g.room === me.room) activeGrenades.delete(key);
        if (settings.mode === 'rounds') { settings.round = null; beginRounds(me.room, settings); }
        broadcast(me.room, { type: 'map', map: m.map });
        break;
      }

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
