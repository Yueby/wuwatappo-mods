// mods/room-history, run against a stand-in for WebSocket (with the accessors on its prototype that the real
// one has, which is what the mod wraps), for localStorage and for `mod`. The frames are the ones the app's
// code reads (see the top of the mod); nobody is in a room and nothing is sent anywhere.
//
//   node --test tests/room-history.test.js

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const folder = path.join(import.meta.dirname, '..', 'mods', 'room-history');
const read = file => fs.readFile(path.join(folder, file), 'utf8');
const mainSource = await read('main.js');
const panelSource = await read('panel.js');
const manifest = JSON.parse(await read('package.json'));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const running = [];
after(() => running.forEach(run => run.dispose()));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Waits are seconds long; the constants are replaced, and each has to have been found.
let source = mainSource;
for (const [name, value] of Object.entries({ SETTLE_MS: 120, LEAVE_GRACE_MS: 150 })) {
  const pattern = new RegExp(`const ${name} = [\\d_]+;`);
  assert.match(source, pattern, `${name} is in the mod`);
  source = source.replace(pattern, `const ${name} = ${value};`);
}

// A WebSocket as the browser has it: onopen / onmessage / onclose are accessors on the prototype, and what
// the page sets there is called with the event.
function makeWebSocket() {
  const handlers = new WeakMap();
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = { open: [], message: [], close: [] };
      this.sent = [];
    }
    addEventListener(type, fn) { this.listeners[type].push(fn); }
    send(data) { this.sent.push(data); }
    // What the network does: tell whoever listens.
    deliver(type, event = {}) {
      if (type === 'open') this.readyState = 1;
      if (type === 'close') this.readyState = 3;
      for (const fn of [...this.listeners[type], handlers.get(this)?.[type]].filter(Boolean)) fn(event);
    }
    frame(event, payload) { this.deliver('message', { data: `42["${event}",${JSON.stringify(payload)}]\n` }); }
  }
  for (const type of ['open', 'message', 'close']) {
    Object.defineProperty(FakeWebSocket.prototype, `on${type}`, {
      configurable: true,
      enumerable: true,
      get() { return handlers.get(this)?.[type] ?? null; },
      set(fn) { handlers.set(this, { ...handlers.get(this), [type]: fn }); },
    });
  }
  return FakeWebSocket;
}

const ROOM_URL = room => `wss://api-mc-wuwatappo.kurogames-global.com/socket.io/?token=x&rm=${room}&EIO=3&transport=websocket`;

function makeStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = String(value); }, removeItem: key => { delete data[key]; } };
}

function load({ config = {}, storage = makeStorage() } = {}) {
  const WebSocket = makeWebSocket();
  const settings = { max: 300, ...config };
  const disposers = [];
  const live = {};
  const logs = [];
  const warnings = [];
  const mod = {
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => warnings.push(a.join(' ')),
    live: (key, value) => { live[key] = value; },
    onDispose: fn => disposers.push(fn),
    config: { get: key => settings[key] },
  };
  const listeners = [];
  const window = {
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener: (type, fn) => { const at = listeners.findIndex(l => l[0] === type && l[1] === fn); if (at >= 0) listeners.splice(at, 1); },
  };
  new AsyncFunction('mod', 'WebSocket', 'localStorage', 'window', source)(mod, WebSocket, storage, window);
  const run = {
    mod, WebSocket, storage, live, logs, warnings, settings, window, listeners,
    dispose: () => disposers.forEach(fn => fn()),
    history: () => JSON.parse(storage.data['modkit-room-history'] ?? '[]'),
    // The app: makes the socket, then sets its handlers, as engine.io does.
    connect(url = ROOM_URL('V3f9IQD1f')) {
      const socket = new WebSocket(url);
      socket.onopen = () => {};
      socket.onmessage = () => {};
      socket.onclose = () => {};
      return socket;
    },
  };
  running.push(run);
  return run;
}

const kinds = run => run.history().map(entry => [entry.type, entry.name ?? null, entry.room ?? null]);

test('it only listens: no permission, no network, no call of the app, and the history stays here', () => {
  assert.equal(manifest.modkit.permissions, undefined);
  assert.equal(manifest.modkit.host, undefined, 'no Node part');
  const code = (mainSource + panelSource).replace(/\/\/.*$/gm, '');
  assert.ok(!/fetch\(|XMLHttpRequest|invoke\(|new WebSocket|\.emit\(/.test(code), 'it does not send or call anything');
  assert.deepEqual(manifest.modkit.settings.map(s => s.key), ['room', 'count', 'max']);
});

test('somebody coming in is written down with the room number, the nickname and the time', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  await sleep(200);                                          // past the first moments of the room
  const before = Date.now();
  socket.frame('rj', { a: 99051, n: '小明', b: 1, c: 2, d: '' });

  const entries = run.history();
  assert.deepEqual(entries.map(e => [e.type, e.name, e.room, e.id]), [['me-in', undefined, 'V3f9IQD1f', undefined], ['join', '小明', 'V3f9IQD1f', 99051]]);
  assert.ok(entries[1].t >= before - 5 && entries[1].t <= Date.now());
  assert.equal(run.live.room, 'V3f9IQD1f');
  assert.equal(run.live.count, '2 条');
});

test('a leave names only an id, and the nickname comes from when the person came in', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  await sleep(200);
  socket.frame('rj', { a: 7, n: '阿青' });
  socket.frame('rl', { a: 7 });

  assert.deepEqual(kinds(run).slice(1), [['join', '阿青', 'V3f9IQD1f'], ['leave', '阿青', 'V3f9IQD1f']]);
});

test('the nickname is found in the history too, when this connection never saw the person come in', async () => {
  const storage = makeStorage({ 'modkit-room-history': JSON.stringify([{ t: 1, room: 'old', type: 'join', id: 9, name: '老朋友' }]) });
  const run = load({ storage });
  const socket = run.connect();
  socket.deliver('open');
  socket.frame('rl', { a: 9 });
  socket.frame('rl', { a: 1234 });

  assert.deepEqual(kinds(run).slice(-2), [['leave', '老朋友', 'V3f9IQD1f'], ['leave', '玩家 1234', 'V3f9IQD1f']]);
});

test('the people who were already there are "here", not "came in"; later ones come in', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  socket.frame('rc', { a: 5, n: '先到的', b: 1, c: 1, d: '' });       // told to a newcomer
  socket.frame('rj', { a: 6, n: '也先到', b: 1, c: 1 });
  await sleep(200);
  socket.frame('rj', { a: 8, n: '后到的', b: 1, c: 1 });

  assert.deepEqual(kinds(run).slice(1), [['here', '先到的', 'V3f9IQD1f'], ['here', '也先到', 'V3f9IQD1f'], ['join', '后到的', 'V3f9IQD1f']]);
});

test('the same person told twice is one record, and a changed nickname does not make a new one', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  await sleep(200);
  socket.frame('rj', { a: 3, n: '甲' });
  socket.frame('rj', { a: 3, n: '甲' });
  socket.frame('rc', { a: 3, n: '甲乙', b: 1 });
  socket.frame('rl', { a: 3 });

  assert.deepEqual(kinds(run).slice(1), [['join', '甲', 'V3f9IQD1f'], ['leave', '甲乙', 'V3f9IQD1f']]);
});

test('going offline is written once, and coming back is written as coming back', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  await sleep(200);
  socket.frame('rj', { a: 4, n: '丙' });
  socket.frame('ro', { a: 4 });
  socket.frame('ro', { a: 4 });
  socket.frame('rj', { a: 4, n: '丙' });

  assert.deepEqual(kinds(run).slice(1).map(k => k[0]), ['join', 'offline', 'online']);
});

test('what is not about who is in the room is not written down', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  await sleep(200);
  socket.frame('rc', { a: '95007|99051' });                  // who pressed a key
  socket.frame('rc', { a: '99051', n: '按键的人' });          // the same, one person: the app reads a text "a" as that, whatever else is in it
  socket.frame('rc', { a: 5, o: 1 });                        // nothing but a and o
  socket.frame('rd', { a: 5, n: 'x' });                      // what somebody looks like
  socket.frame('rj', { a: 'abc', n: 'x' });                  // not an id
  socket.deliver('message', { data: '2' });                  // a ping
  socket.deliver('message', { data: '42["rj",{broken' });    // not JSON
  socket.deliver('message', { data: new Uint8Array(3) });    // not text

  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in']);
});

test('a connection that is not the room (no room number, or another address) writes nothing', async () => {
  const run = load();
  const lobby = run.connect(ROOM_URL(''));
  lobby.deliver('open');
  lobby.frame('rj', { a: 1, n: 'x' });
  const other = run.connect('wss://example.com/live?rm=abc');
  other.deliver('open');
  other.frame('rj', { a: 2, n: 'y' });

  assert.deepEqual(run.history(), []);
  assert.equal(run.live.room, '不在房间里');
});

test('leaving the room is written when the connection ends and stays ended; a dropped one that comes back is not leaving', async () => {
  const run = load();
  const first = run.connect();
  first.deliver('open');
  first.deliver('close');
  const second = run.connect();                              // the app reconnects at once
  second.deliver('open');
  await sleep(300);
  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in'], 'a drop and a return is neither a leaving nor a coming in');

  second.deliver('close');
  assert.equal(run.live.room, '不在房间里');
  await sleep(300);
  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in', 'me-out']);
  assert.equal(run.history().at(-1).room, 'V3f9IQD1f');
});

test('going into another room is a leaving and a coming in, each with its own room number', async () => {
  const run = load();
  const first = run.connect(ROOM_URL('AAA'));
  first.deliver('open');
  first.deliver('close');
  const second = run.connect(ROOM_URL('BBB'));
  second.deliver('open');
  await sleep(300);

  assert.deepEqual(kinds(run).map(k => [k[0], k[2]]), [['me-in', 'AAA'], ['me-in', 'BBB'], ['me-out', 'AAA']]);
  assert.equal(run.live.room, 'BBB');
});

test('two rooms left one after the other: both leavings are written', async () => {
  const run = load();
  const a = run.connect(ROOM_URL('AAA'));
  a.deliver('open');
  a.deliver('close');
  const b = run.connect(ROOM_URL('BBB'));
  b.deliver('open');
  b.deliver('close');                                        // before the first one's wait was over
  await sleep(300);
  assert.deepEqual(kinds(run).map(k => [k[0], k[2]]), [['me-in', 'AAA'], ['me-in', 'BBB'], ['me-out', 'AAA'], ['me-out', 'BBB']]);
});

test('a room being closed is written down', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  socket.frame('rs', { r: 'V3f9IQD1f' });
  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in', 'dismiss']);
});

test('a socket that was already open when the mod started is picked up at its next ping, and is not a coming in', async () => {
  const storage = makeStorage();
  // The app's connection exists first; the mod starts afterwards.
  const WebSocket = makeWebSocket();
  const socket = new WebSocket(ROOM_URL('LATE'));
  socket.deliver('open');
  const calls = [];
  const mod = { log() {}, warn() {}, live: (k, v) => calls.push([k, v]), onDispose: fn => running.push({ dispose: fn }), config: { get: () => 300 } };
  new AsyncFunction('mod', 'WebSocket', 'localStorage', 'window', source)(mod, WebSocket, storage, { addEventListener() {}, removeEventListener() {} });

  assert.deepEqual(JSON.parse(storage.data['modkit-room-history'] ?? '[]'), []);
  socket.send('2');                                          // the ping
  assert.equal(socket.sent.length, 1, 'the ping still goes out');
  assert.deepEqual(calls.at(-1), ['room', 'LATE']);
  socket.frame('rj', { a: 11, n: '丁' });                    // a real join after that
  const entries = JSON.parse(storage.data['modkit-room-history']);
  assert.deepEqual(entries.map(e => [e.type, e.name, e.room]), [['here', '丁', 'LATE']], 'the first moments after picking up are not told apart from "were there"');
});

test('the history is kept to the number set, oldest out first, and survives a restart', async () => {
  const run = load({ config: { max: 20 } });
  const socket = run.connect();
  socket.deliver('open');
  await sleep(200);
  for (let i = 1; i <= 30; i += 1) socket.frame('rj', { a: i, n: `玩家${i}` });
  assert.equal(run.history().length, 20);
  assert.equal(run.history().at(-1).name, '玩家30');
  assert.equal(run.history()[0].name, '玩家11');
  assert.equal(run.live.count, '20 条');

  const again = load({ storage: run.storage });              // a restart: the same storage
  assert.equal(again.live.count, '20 条');
});

test('clearing the history from the panel updates the count', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  assert.equal(run.live.count, '1 条');
  delete run.storage.data['modkit-room-history'];
  for (const [type, fn] of run.listeners) if (type === 'storage') fn({ key: 'modkit-room-history' });
  assert.equal(run.live.count, '0 条');
});

test('turned off, it gives WebSocket back as it was, and the sockets it had go quiet', async () => {
  const run = load();
  const proto = run.WebSocket.prototype;
  const wrapped = Object.getOwnPropertyDescriptor(proto, 'onmessage').set;
  const socket = run.connect();
  socket.deliver('open');
  run.dispose();

  assert.notEqual(Object.getOwnPropertyDescriptor(proto, 'onmessage').set, wrapped, 'the accessor is the original again');
  assert.equal(run.listeners.length, 0, 'its storage listener is gone');
  socket.frame('rj', { a: 1, n: '谁' });
  socket.deliver('close');
  await sleep(300);
  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in'], 'nothing is written after it is off');

  const later = new run.WebSocket(ROOM_URL('X'));
  later.onmessage = () => {};
  assert.equal(run.history().length, 1, 'a socket made afterwards is not looked at');
});

// --- the panel half --------------------------------------------------------------------------------------

test('the list in the settings dialog: newest first, the room number under each, the time on the right, and a way to clear', async () => {
  const entries = [
    { t: new Date(2026, 9, 29, 14, 3, 5).getTime(), room: 'ROOM1', type: 'join', id: 1, name: '甲' },
    { t: new Date(2026, 9, 29, 14, 9, 30).getTime(), room: 'ROOM1', type: 'leave', id: 1, name: '甲' },
  ];
  const storage = makeStorage({ 'modkit-room-history': JSON.stringify(entries) });
  const rows = [];
  let redraws = 0;
  const mod = {
    entry: def => { rows.push(def); return () => rows.splice(rows.indexOf(def), 1); },
    onDispose: fn => running.push({ dispose: fn }),
  };
  const listeners = [];
  const window = {
    modkit: { changed: () => { redraws += 1; } },
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener() {},
  };
  new AsyncFunction('mod', 'localStorage', 'window', panelSource)(mod, storage, window);

  assert.deepEqual(rows.map(r => r.title), ['清空记录', '甲 离开了房间', '甲 进入了房间']);
  assert.deepEqual(rows.slice(1).map(r => r.description), ['房间号 ROOM1', '房间号 ROOM1']);
  assert.deepEqual(rows.slice(1).map(r => r.value), ['10-29 14:09:30', '10-29 14:03:05']);
  assert.equal(rows[0].description, '共 2 条');

  rows[0].button.onClick();                                   // 清空
  assert.equal(storage.data['modkit-room-history'], undefined);
  assert.deepEqual(rows.map(r => r.title), ['清空记录', '还没有记录']);
  assert.equal(rows[0].button.disabled, true);

  // The main window writes: the storage event makes it draw again.
  storage.data['modkit-room-history'] = JSON.stringify(entries.slice(0, 1));
  for (const [type, fn] of listeners) if (type === 'storage') fn({ key: 'modkit-room-history' });
  assert.deepEqual(rows.map(r => r.title), ['清空记录', '还没有记录'], 'one drawing for the burst, not one per write: not yet');
  await sleep(300);
  assert.deepEqual(rows.map(r => r.title), ['清空记录', '甲 进入了房间']);
  assert.ok(redraws >= 3);
});
