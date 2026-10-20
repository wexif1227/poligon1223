const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

test('room-scoped grenade relay, owner validation and duplicate suppression', async () => {
  const server = spawn(process.execPath, [require.resolve('./server')], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const sockets = [];
  try {
    const line = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
      server.once('error', reject);
      server.stdout.once('data', data => { clearTimeout(timer); resolve(data.toString()); });
    });
    const port = Number(line.match(/port (\d+)/)[1]);
    async function client(room) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      sockets.push(ws);
      const messages = [];
      ws.on('message', data => messages.push(JSON.parse(data)));
      await once(ws, 'open');
      ws.send(JSON.stringify({ type: 'join', name: room, room, map: 'rust' }));
      await until(() => messages.some(m => m.type === 'welcome'));
      return { ws, messages, id: messages.find(m => m.type === 'welcome').id };
    }
    const a = await client('A'), b = await client('A'), c = await client('B');
    assert.equal(b.messages.find(m => m.type === 'welcome').map, 'rust');
    const payload = { type: 'grenadeThrow', gid: 'regression-1', kind: 'smoke',
      x: 0, y: 2, z: 0, vx: 12, vy: 5, vz: -3 };
    a.ws.send(JSON.stringify(payload));
    await until(() => b.messages.some(m => m.type === 'grenadeThrow'));
    assert.equal(b.messages.find(m => m.type === 'grenadeThrow').id, a.id);
    const det = { type: 'grenadeDet', gid: payload.gid, kind: 'smoke', x: 4, y: 0, z: -2 };
    b.ws.send(JSON.stringify(det)); // A different player cannot detonate it.
    a.ws.send(JSON.stringify({ ...payload, gid: 'invalid', vx: 'NaN' }));
    await delay(80);
    assert.equal(a.messages.filter(m => m.type === 'grenadeDet').length, 0);
    a.ws.send(JSON.stringify(det));
    await until(() => b.messages.some(m => m.type === 'grenadeDet'));
    a.ws.send(JSON.stringify(det));
    a.ws.send(JSON.stringify(payload));
    await delay(80);
    assert.equal(b.messages.filter(m => m.type === 'grenadeDet').length, 1);
    assert.equal(b.messages.filter(m => m.type === 'grenadeThrow').length, 1);
    assert.equal(c.messages.filter(m => m.type.startsWith('grenade')).length, 0);
    assert.equal(a.messages.filter(m => m.type.startsWith('grenade')).length, 0);
    a.ws.send(JSON.stringify({ type: 'map', map: 'sandstone' }));
    await until(() => b.messages.some(m => m.type === 'map' && m.map === 'sandstone'));
    const late = await client('A');
    assert.equal(late.messages.find(m => m.type === 'welcome').map, 'sandstone');
  } finally {
    for (const ws of sockets) ws.terminate();
    server.kill();
    await once(server, 'exit');
  }
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error('Expected multiplayer message did not arrive');
}
