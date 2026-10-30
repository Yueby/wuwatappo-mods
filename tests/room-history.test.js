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
for (const [name, value] of Object.entries({ SETTLE_MS: 120, LEAVE_GRACE_MS: 150, BEAT_MS: 40, RECONNECT_MS: 600 })) {
  const pattern = new RegExp(`const ${name} = [\\d_]+;`);
  assert.match(source, pattern, `${name} is in the mod`);
  source = source.replace(pattern, `const ${name} = ${value};`);
}

// The panel half polls every two seconds and writes again every ten; a test cannot wait that.
let panelFast = panelSource;
for (const [name, value] of Object.entries({ POLL_MS: 30, REFRESH_MS: 200 })) {
  const pattern = new RegExp(`const ${name} = [\\d_]+;`);
  assert.match(panelFast, pattern, `${name} is in the panel half`);
  panelFast = panelFast.replace(pattern, `const ${name} = ${value};`);
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
    answer(number, reply) { this.deliver('message', { data: `43${number}[${JSON.stringify(reply)}]\n` }); }
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
  const before = { send: WebSocket.prototype.send };
  for (const name of ['onopen', 'onmessage', 'onclose']) before[name] = Object.getOwnPropertyDescriptor(WebSocket.prototype, name);
  new AsyncFunction('mod', 'WebSocket', 'localStorage', 'window', source)(mod, WebSocket, storage, window);
  const run = {
    before,
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

test('it only listens: the one permission is the clipboard (for 复制), no network, no call of the app, and the history stays here', () => {
  assert.deepEqual(manifest.modkit.permissions, ['clipboard', 'page', 'app-commands']);
  assert.equal(manifest.modkit.api, 4);
  assert.equal(manifest.modkit.host, undefined, 'no Node part');
  const code = (mainSource + panelSource).replace(/\/\/.*$/gm, '');
  assert.ok(!/fetch\(|XMLHttpRequest|new WebSocket|\.emit\(/.test(code), 'it does not send or call anything');
  const calls = [...code.matchAll(/invoke\(([^,)]*)/g)].map(match => match[1].trim());
  assert.deepEqual(calls, ["'plugin:window|is_visible'"], 'the one command it asks the app is whether the panel is shown: a question, not an action');
  assert.equal((code.match(/clipboard/g) ?? []).length, 1, 'the clipboard is used in one place, and only to write the room number');
  assert.match(code, /clipboard\.writeText\(visit\.room\)/);
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
  await sleep(30);
  const b = run.connect(ROOM_URL('BBB'));
  b.deliver('open');
  await sleep(30);
  b.deliver('close');                                        // before the first one's wait was over
  await sleep(300);
  assert.deepEqual(kinds(run).map(k => [k[0], k[2]]), [['me-in', 'AAA'], ['me-in', 'BBB'], ['me-out', 'AAA'], ['me-out', 'BBB']]);
  const [, inB, outA] = run.history();
  assert.ok(outA.t < inB.t, 'the first room was left before the second was come into, and that is what it says');
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

test('the log says what the first message of each kind looked like, and what could not be read, a few times and no more', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  await sleep(200);
  socket.frame('rj', { a: 5, n: '甲' });
  socket.frame('rj', { a: 6, n: '乙' });
  socket.frame('rl', { a: 5 });
  assert.deepEqual(run.logs.map(l => l.replace(/：.*/, '')), ['第一次收到 rj', '第一次收到 rl'], 'once for each kind');
  assert.match(run.logs[0], /"a":5,"n":"〇"/, 'as it came, but for the nickname');

  for (let i = 0; i < 30; i += 1) socket.frame('rl', { a: 'not an id' });
  socket.frame('rj', { n: '没有编号' });
  socket.frame('ro', {});
  assert.equal(run.warnings.length, 10, 'ten warnings, then quiet');
  assert.match(run.warnings[0], /没能读懂 rl：\{"a":"not an id"\}/);
  assert.match(run.warnings.at(-1), /后面的不再提示/);
  assert.equal(run.history().length, 4, 'nothing was written for what could not be read: the room, two joins and a leave');
});

test('the leaving is dated when the connection was lost, not when the wait for a return was over', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  const lost = Date.now();
  socket.deliver('close');
  await sleep(300);
  const out = run.history().find(entry => entry.type === 'me-out');
  assert.ok(out && out.t >= lost && out.t < lost + 60, `dated at the loss (${out?.t - lost} ms after), not 150 ms later`);
});

// --- the panel half --------------------------------------------------------------------------------------

const at = (day, h, m, s = 0) => new Date(2026, 9, day, h, m, s).getTime();

function loadPanel(entries, { here = null, clipboard = { writes: [], fails: false }, vue = null, shown = null } = {}) {
  const storage = makeStorage(entries ? { 'modkit-room-history': typeof entries === 'string' ? entries : JSON.stringify(entries) } : {});
  const rows = [];
  let redraws = 0;
  const disposers = [];
  const mod = {
    entry: def => { rows.push(def); return () => rows.splice(rows.indexOf(def), 1); },
    onDispose: fn => { disposers.push(fn); running.push({ dispose: fn }); },
    ...(shown ? { invoke: async (command, args) => { shown.asked.push([command, args]); if (shown.fails) throw new Error('no'); return shown.open; } } : {}),
  };
  const listeners = [];
  const live = new Map([['room-history', new Map(here ? [['room', here]] : [])]]);
  const window = {
    modkit: { changed: () => { redraws += 1; }, live },
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener() {},
  };
  const makeButton = () => ({ handlers: [], className: '', textContent: '', addEventListener(type, fn) { this.handlers.push(fn); }, press() { this.handlers.forEach(fn => fn()); } });
  const document = {
    createElement: tag => { assert.equal(tag, 'button'); return makeButton(); },
    querySelector: selector => (selector === '#app' && vue ? { __vue_app__: vue } : null),
  };
  const navigator = { clipboard: { writeText: text => { clipboard.writes.push(text); return clipboard.fails ? Promise.reject(new Error('no')) : Promise.resolve(); } } };
  new AsyncFunction('mod', 'localStorage', 'window', 'document', 'navigator', panelFast)(mod, storage, window, document, navigator);
  return {
    rows, storage, clipboard,
    dispose: () => disposers.forEach(fn => fn()),
    redraws: () => redraws,
    titles: () => rows.map(r => r.title),
    row: title => rows.find(r => r.title === title),
    controlsOf: title => rows.find(r => r.title === title).render(),
    storageEvent: () => { for (const [type, fn] of listeners) if (type === 'storage') fn({ key: 'modkit-room-history' }); },
  };
}

// Two visits: AAA (a long one, three people), BBB (the latest, still going).
const HISTORY = [
  { t: at(29, 14, 0), room: 'AAA', type: 'me-in' },
  { t: at(29, 14, 0, 1), room: 'AAA', type: 'here', id: 1, name: '早到的' },
  { t: at(29, 14, 10), room: 'AAA', type: 'join', id: 2, name: '小明' },
  { t: at(29, 14, 12), room: 'AAA', type: 'join', id: 3, name: '阿青' },
  { t: at(29, 14, 22), room: 'AAA', type: 'leave', id: 2, name: '小明' },
  { t: at(29, 14, 40), room: 'AAA', type: 'offline', id: 1, name: '早到的' },
  { t: at(29, 14, 45), room: 'AAA', type: 'me-out' },
  { t: at(29, 16, 0), room: 'BBB', type: 'me-in' },
  { t: at(29, 16, 5), room: 'BBB', type: 'join', id: 4, name: '路人' },
];

test('the list is by room: one row for each, the newest first and open, with the room number, when, how many people and how long', () => {
  const panel = loadPanel(HISTORY, { here: 'BBB' });
  assert.deepEqual(panel.titles(), ['清空记录', '房间号 BBB', '　路人 进入了房间', '房间号 AAA']);
  assert.equal(panel.rows[0].description, '共 9 条记录，2 个房间');
  assert.equal(panel.row('房间号 BBB').description, '10-29 16:00:00 · 1 人 · 还在这个房间里');
  assert.equal(panel.row('房间号 AAA').description, '10-29 14:00:00 到 14:45:00 · 3 人 · 待了 45 分钟');
  assert.equal(panel.row('　路人 进入了房间').value, '10-29 16:05:00');
});

test('a room with no leaving on record, one with no beginning on record, and one that was closed, each say so', () => {
  const noLeave = loadPanel(HISTORY.slice(0, 6), { here: null });
  assert.equal(noLeave.row('房间号 AAA').description, '10-29 14:00:00 · 3 人 · 没有记录到离开');

  const cut = loadPanel([{ t: at(29, 9, 0), room: 'CCC', type: 'join', id: 8, name: '谁' }], { here: null });
  assert.equal(cut.row('房间号 CCC').description, '10-29 09:00:00 起有记录 · 1 人 · 没有记录到离开', 'no beginning on record: no length either');

  const closed = loadPanel([{ t: at(29, 9, 0), room: 'DDD', type: 'me-in' }, { t: at(29, 9, 30), room: 'DDD', type: 'dismiss' }]);
  assert.equal(closed.row('房间号 DDD').description, '10-29 09:00:00 到 09:30:00 · 待了 30 分钟 · 房间被解散');
});

test('opening a room shows what happened in it, newest first, with how long each person who left stayed', () => {
  const panel = loadPanel(HISTORY, { here: 'BBB' });
  const [, toggle] = panel.controlsOf('房间号 AAA');
  assert.equal(toggle.textContent, '展开');

  toggle.press();
  assert.deepEqual(panel.titles().slice(3), ['房间号 AAA', '　早到的 掉线了', '　小明 离开了房间', '　阿青 进入了房间', '　小明 进入了房间', '　早到的 已在房间里']);
  assert.equal(panel.row('　小明 离开了房间').description, '待了 12 分钟', 'came 14:10, went 14:22');
  assert.equal(panel.row('　早到的 掉线了').description, '至少待了 40 分钟（进房前就已在房间里）', 'he was already there: it is a longer time than it says');
  assert.equal(panel.row('　阿青 进入了房间').description, '');
  assert.equal(panel.controlsOf('房间号 AAA')[1].textContent, '收起');

  panel.controlsOf('房间号 AAA')[1].press();
  assert.deepEqual(panel.titles(), ['清空记录', '房间号 BBB', '　路人 进入了房间', '房间号 AAA']);
  panel.controlsOf('房间号 BBB')[1].press();                           // the newest one can be closed as well
  assert.deepEqual(panel.titles(), ['清空记录', '房间号 BBB', '房间号 AAA']);
});

test('复制 puts the room number on the clipboard, and says so', async () => {
  const panel = loadPanel(HISTORY);
  const [copy] = panel.controlsOf('房间号 AAA');
  copy.press();
  assert.deepEqual(panel.clipboard.writes, ['AAA']);
  await sleep(10);
  assert.equal(copy.textContent, '已复制');

  const refused = loadPanel(HISTORY, { clipboard: { writes: [], fails: true } });
  const [again] = refused.controlsOf('房间号 BBB');
  again.press();
  await sleep(10);
  assert.equal(again.textContent, '复制失败');
});

test('only the latest rooms are drawn, and the first row says how many there are', () => {
  const many = [];
  for (let i = 0; i < 40; i += 1) many.push({ t: at(1 + (i % 28), 10, i), room: `R${i}`, type: 'me-in' }, { t: at(1 + (i % 28), 10, i, 30), room: `R${i}`, type: 'me-out' });
  const panel = loadPanel(many);
  assert.equal(panel.rows.filter(r => r.title.startsWith('房间号')).length, 30);
  assert.equal(panel.rows[0].description, '共 80 条记录，40 个房间，这里显示最近 30 个');
});

test('clearing empties the list, and the list is drawn again when the main window writes', async () => {
  const panel = loadPanel(HISTORY);
  panel.rows[0].button.onClick();
  assert.equal(panel.storage.data['modkit-room-history'], undefined);
  assert.deepEqual(panel.titles(), ['清空记录', '还没有记录']);
  assert.equal(panel.rows[0].button.disabled, true);

  panel.storage.data['modkit-room-history'] = JSON.stringify(HISTORY.slice(0, 3));
  panel.storageEvent();
  panel.storageEvent();
  assert.deepEqual(panel.titles(), ['清空记录', '还没有记录'], 'not at once: the write was just now');
  await sleep(300);
  assert.equal(panel.titles()[1], '房间号 AAA');
  assert.ok(panel.redraws() >= 3);
});

test('a damaged history does not stop the page from drawing: what cannot be read is left out', () => {
  for (const bad of ['{not json', '"text"']) {
    const panel = loadPanel(bad);
    assert.deepEqual(panel.titles(), ['清空记录', '还没有记录'], bad);
  }
  const partly = loadPanel('[null, 5, {"room": 1}, {"t": 1, "room": "X", "type": "join", "id": 3, "name": "还在"}]');
  assert.deepEqual(partly.titles(), ['清空记录', '房间号 X', '　还在 进入了房间'], 'the one record that is whole is shown');
});

// --- who is already in the room --------------------------------------------------------------------------

const ROSTER = { c: 0, d: { r: 'V3f9IQD1f', m: [{ u: 5, n: '房主甲', o: 1, l: 1 }, { u: 6, n: '路人乙', o: 0, l: 1 }, { u: 7, n: '离线丙', o: 0, l: 0 }] } };

test('the people who are in the room when it is entered, from the answer the app gets, are "here", with the owner and who is offline', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  socket.answer(12, ROSTER);

  assert.deepEqual(run.history().slice(1).map(e => [e.type, e.name, e.id, e.owner ?? false, e.offline ?? false, e.room]), [
    ['here', '房主甲', 5, true, false, 'V3f9IQD1f'],
    ['here', '路人乙', 6, false, false, 'V3f9IQD1f'],
    ['here', '离线丙', 7, false, true, 'V3f9IQD1f'],
  ]);

  socket.frame('rl', { a: 6 });                              // they are known now: a leave has the nickname
  assert.deepEqual(kinds(run).at(-1), ['leave', '路人乙', 'V3f9IQD1f']);
  assert.match(run.logs[0], /第一次收到 名单：.*"n":"〇〇〇"/, 'the shape is in the log, the nicknames are not');
  assert.ok(!run.logs.join('\n').includes('房主甲'));
});

test('somebody already told about by an event is not written twice when the list comes', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  socket.frame('rc', { a: 6, n: '路人乙', b: 1, c: 1, d: '', o: 0 });
  socket.answer(1, ROSTER);
  socket.answer(2, ROSTER);                                  // asked again: nobody is new

  assert.deepEqual(kinds(run).slice(1).map(k => k[1]), ['路人乙', '房主甲', '离线丙']);
});

test('an answer that is not the list of a room is left alone, and a member that cannot be read is said so', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  socket.answer(1, { c: 0, d: { r: 'V3f9IQD1f' } });        // an answer with no members
  socket.answer(2, { c: 0 });
  socket.answer(3, 'ok');
  socket.deliver('message', { data: '43' });
  socket.deliver('message', { data: '43[broken' });
  assert.deepEqual(run.history().length, 1, 'only the coming in');
  assert.deepEqual(run.warnings, []);

  socket.answer(4, { c: 0, d: { r: 'V3f9IQD1f', m: [{ n: '没有编号' }, { u: 9, n: '正常' }] } });
  assert.deepEqual(kinds(run).slice(1).map(k => k[1]), ['正常']);
  assert.match(run.warnings[0], /没能读懂 名单/);
});

test('a connection with no room writes nothing even when a list comes; one picked up late reads a list if one does come', async () => {
  const run = load();
  const lobby = run.connect(ROOM_URL(''));
  lobby.deliver('open');
  lobby.answer(1, ROSTER);
  assert.deepEqual(run.history(), [], 'a connection with no room writes nothing');

  const WebSocket = makeWebSocket();
  const storage = makeStorage();
  const late = new WebSocket(ROOM_URL('LATE'));
  late.deliver('open');
  new AsyncFunction('mod', 'WebSocket', 'localStorage', 'window', source)({ log() {}, warn() {}, live() {}, onDispose: fn => running.push({ dispose: fn }), config: { get: () => 300 } }, WebSocket, storage, { addEventListener() {}, removeEventListener() {} });
  late.send('2');                                            // picked up at the ping: the list came long ago
  late.answer(1, { c: 0, d: { r: 'LATE', m: [{ u: 1, n: '谁', o: 0, l: 1 }] } });
  assert.deepEqual(JSON.parse(storage.data['modkit-room-history'] ?? '[]').map(e => e.type), ['here'], 'if one does come, it is read');
});

test('in the list in the dialog the owner and the one who is offline are said', () => {
  const panel = loadPanel([
    { t: at(29, 9, 0), room: 'EEE', type: 'me-in' },
    { t: at(29, 9, 0, 1), room: 'EEE', type: 'here', id: 1, name: '房主', owner: true },
    { t: at(29, 9, 0, 1), room: 'EEE', type: 'here', id: 2, name: '掉线的', offline: true },
    { t: at(29, 9, 0, 1), room: 'EEE', type: 'here', id: 3, name: '普通人' },
  ]);
  assert.deepEqual(panel.titles().slice(2), ['　普通人 已在房间里', '　掉线的 已在房间里（离线）', '　房主 已在房间里（房主）']);
});

// --- who was there when the plugin started: the panel's list -----------------------------------------------

const MEMBERS_KEY = 'modkit-room-history-members';

// A plugin started in the middle of a room: the socket was open before it, the panel has said who is in it.
function loadLate({ room = 'LATE', snapshot = null, reuse = null } = {}) {
  const WebSocket = reuse?.WebSocket ?? makeWebSocket();
  const storage = reuse?.storage ?? makeStorage();
  if (snapshot) storage.data[MEMBERS_KEY] = JSON.stringify(snapshot);
  const socket = reuse?.socket ?? new WebSocket(ROOM_URL(room));
  if (!reuse) socket.deliver('open');
  const listeners = [];
  const disposers = [];
  const mod = { log() {}, warn() {}, live() {}, onDispose: fn => { disposers.push(fn); running.push({ dispose: fn }); }, config: { get: () => 300 } };
  const window = {
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener() {},
  };
  new AsyncFunction('mod', 'WebSocket', 'localStorage', 'window', source)(mod, WebSocket, storage, window);
  return {
    socket, storage, WebSocket,
    dispose: () => disposers.forEach(fn => fn()),
    history: () => JSON.parse(storage.data['modkit-room-history'] ?? '[]'),
    say: snapshot => { storage.data[MEMBERS_KEY] = JSON.stringify(snapshot); for (const [type, fn] of listeners) if (type === 'storage') fn({ key: MEMBERS_KEY }); },
  };
}

const people = [
  { id: 99, name: '我自己', owner: false, online: true },
  { id: 1, name: '房主', owner: true, online: true },
  { id: 2, name: '掉线的', owner: false, online: false },
];

test('started in the middle of a room, the people the panel says are there are written as "here", and the person themselves is not one of them', () => {
  const late = loadLate({ snapshot: { room: 'LATE', self: 99, t: Date.now(), members: people } });
  assert.deepEqual(late.history(), [], 'nothing until the connection is picked up');

  late.socket.send('2');                                      // the ping: it is picked up
  assert.deepEqual(late.history().map(e => [e.type, e.name, e.id, e.owner ?? false, e.offline ?? false, e.room]), [
    ['here', '房主', 1, true, false, 'LATE'],
    ['here', '掉线的', 2, false, true, 'LATE'],
  ]);

  late.say({ room: 'LATE', self: 99, t: Date.now(), members: [...people, { id: 3, name: '新来的', owner: false, online: true }] });
  late.say({ room: 'LATE', self: 99, t: Date.now(), members: [...people, { id: 3, name: '新来的', owner: false, online: true }] });
  assert.deepEqual(late.history().map(e => e.name), ['房主', '掉线的', '新来的'], 'the new one once; the ones known are not written again');

  late.socket.frame('rl', { a: 2 });                          // known now: the leave has the nickname
  assert.deepEqual(late.history().at(-1), { ...late.history().at(-1), type: 'leave', name: '掉线的' });

  late.socket.frame('rj', { a: 99, n: '我自己' });            // the person themselves
  late.socket.frame('rl', { a: 99 });
  late.socket.frame('ro', { a: 99 });
  assert.equal(late.history().length, 4, 'what is about oneself is the connection opening and closing, not these');
});

test('a copy of the panel\'s list that is for another room, old, or damaged is not believed', () => {
  for (const [label, snapshot] of [
    ['another room', { room: 'OTHER', self: 99, t: Date.now(), members: people }],
    ['old', { room: 'LATE', self: 99, t: Date.now() - 120_000, members: people }],
    ['no time', { room: 'LATE', self: 99, members: people }],
    ['no members', { room: 'LATE', self: 99, t: Date.now(), members: 'x' }],
  ]) {
    const late = loadLate({ snapshot });
    late.socket.send('2');
    assert.deepEqual(late.history(), [], label);
  }
  const broken = loadLate();
  broken.storage.data[MEMBERS_KEY] = '{nope';
  broken.socket.send('2');
  assert.deepEqual(broken.history(), []);
});

test('the person is known from the panel before anything of the room is read, so the list the app is answered with does not write them', async () => {
  const run = load({ storage: makeStorage({ [MEMBERS_KEY]: JSON.stringify({ room: 'elsewhere', self: 5, t: Date.now(), members: [] }) }) });
  const socket = run.connect();
  socket.deliver('open');
  socket.answer(1, ROSTER);                                   // ROSTER has a member with id 5: the person
  assert.deepEqual(kinds(run).slice(1).map(k => k[1]), ['路人乙', '离线丙'], 'the owner of the list is the person: not "somebody already there"');
});

test('a connection that drops and comes back to the same room does not write the people already in it again', async () => {
  const run = load();
  const first = run.connect();
  first.deliver('open');
  first.answer(1, ROSTER);
  first.deliver('close');
  const second = run.connect();                               // the app comes back, and asks for the room again
  second.deliver('open');
  second.answer(1, ROSTER);
  await sleep(250);
  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in', 'here', 'here', 'here'], 'the same three, once');
});

// --- the panel half: what it copies for main.js ------------------------------------------------------------

// The page's components, as far as the plugin looks at them: the room's props are on one of them, a level or two down.
function roomTree(props) {
  const room = { props, subTree: null, isUnmounted: false };
  return { room, tree: { _instance: { vnode: { component: { props: {}, subTree: { children: [{ children: [{ component: { props: { other: 1 }, subTree: null } }, { component: room }] }] } } } } } };
}

const PROPS = () => ({
  currentRoomId: 'ROOM1',
  localMemberId: 99,
  roomMembers: [
    { id: 99, nickname: '我自己', isOwner: false, online: true, left: 1, top: 2 },
    { id: 1, nickname: '房主', isOwner: true, online: true },
    { id: 2, nickname: '掉线的', isOwner: false, online: false },
  ],
});

test('the panel half copies who is in the room, with the room number and the person\'s own id, for main.js', async () => {
  const { room, tree } = roomTree(PROPS());
  const panel = loadPanel(null, { vue: tree });
  const written = () => JSON.parse(panel.storage.data[MEMBERS_KEY]);

  assert.deepEqual({ ...written(), t: undefined }, {
    room: 'ROOM1', self: 99, t: undefined,
    members: [{ id: 99, name: '我自己', owner: false, online: true }, { id: 1, name: '房主', owner: true, online: true }, { id: 2, name: '掉线的', owner: false, online: false }],
  }, 'only what is needed: no positions, no animation state');
  assert.ok(Math.abs(written().t - Date.now()) < 2000);

  const first = written().t;
  await sleep(100);
  assert.equal(written().t, first, 'not written again while nothing changes');
  await sleep(300);
  assert.ok(written().t > first, 'but written again after a while, so that it is known to be current');

  room.props.roomMembers = [...room.props.roomMembers, { id: 3, nickname: '新来的', isOwner: false, online: true }];
  await sleep(100);
  assert.deepEqual(written().members.map(m => m.id), [99, 1, 2, 3], 'a change is copied at the next look');

  room.props.currentRoomId = '';
  room.props.roomMembers = [];
  await sleep(100);
  assert.deepEqual([written().room, written().members], ['', []], 'leaving the room is copied too, so that an old list is not left');
});

test('when the page has no room component, or it goes away, nothing is written and nothing breaks; when the plugin stops the copy goes', async () => {
  const none = loadPanel(null, { vue: { _instance: { vnode: { component: { props: {}, subTree: null } } } } });
  await sleep(100);
  assert.equal(none.storage.data[MEMBERS_KEY], undefined);

  const noApp = loadPanel(null);
  await sleep(100);
  assert.equal(noApp.storage.data[MEMBERS_KEY], undefined);

  const { room, tree } = roomTree(PROPS());
  const panel = loadPanel(null, { vue: tree });
  assert.ok(panel.storage.data[MEMBERS_KEY]);
  room.isUnmounted = true;                                    // the page was rebuilt: it is looked for again
  room.props = { get currentRoomId() { throw new Error('gone'); }, roomMembers: [] };
  await sleep(100);                                           // reading it throws: that is not allowed to escape
  panel.dispose();
  assert.equal(panel.storage.data[MEMBERS_KEY], undefined, 'the copy is removed when the plugin stops');
});

// --- started again in the same room ------------------------------------------------------------------------

test('turned off and on, or reloaded, in the middle of a room, the people already written down are not written down again', () => {
  const snapshot = () => ({ room: 'LATE', self: 99, t: Date.now(), members: people });
  const first = loadLate({ snapshot: snapshot() });
  first.socket.send('2');
  assert.equal(first.history().length, 2);

  first.dispose();                                            // what a reload, or the master switch, does
  first.storage.data[MEMBERS_KEY] = JSON.stringify(snapshot());
  const again = loadLate({ reuse: first });
  again.socket.send('2');
  again.say(snapshot());
  assert.equal(again.history().length, 2, 'the same two, once');

  again.say({ ...snapshot(), members: [...people, { id: 4, name: '后来的', owner: false, online: true }] });
  assert.deepEqual(again.history().map(e => e.name), ['房主', '掉线的', '后来的'], 'but somebody who was not there before is');
});

test('somebody written down as offline who the panel now says is online came back, once', () => {
  const late = loadLate({ snapshot: { room: 'LATE', self: 99, t: Date.now(), members: people } });
  late.socket.send('2');
  late.say({ room: 'LATE', self: 99, t: Date.now(), members: people.map(m => (m.id === 2 ? { ...m, online: true } : m)) });
  assert.deepEqual(late.history().map(e => [e.type, e.name]), [['here', '房主'], ['here', '掉线的'], ['online', '掉线的']]);
  late.say({ room: 'LATE', self: 99, t: Date.now(), members: people.map(m => (m.id === 2 ? { ...m, online: true } : m)) });
  assert.equal(late.history().length, 3, 'and not again');
});

test('a room that was left and is entered again has its people written again: it is another time there', async () => {
  const run = load();
  const first = run.connect();
  first.deliver('open');
  first.answer(1, ROSTER);
  first.deliver('close');
  await sleep(300);                                           // gone for good: the leaving is written
  const second = run.connect();
  second.deliver('open');
  second.answer(1, ROSTER);
  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in', 'here', 'here', 'here', 'me-out', 'me-in', 'here', 'here', 'here']);
});

test('somebody told about with no nickname gets it from the panel\'s list, not "玩家 <id>"', () => {
  const late = loadLate({ snapshot: { room: 'LATE', self: 99, t: Date.now() - 120_000, members: people } });   // too old to be believed as a list...
  late.socket.send('2');
  assert.deepEqual(late.history(), []);
  late.storage.data[MEMBERS_KEY] = JSON.stringify({ room: 'LATE', self: 99, t: Date.now(), members: people });   // ...and now current
  late.socket.frame('rc', { a: 1, b: 1, c: 1, d: '', o: 0 });                   // details with no nickname
  assert.equal(late.history()[0].name, '房主');
});

test('started again, an event about somebody already written down is not written down again either', () => {
  const first = loadLate({ snapshot: { room: 'LATE', self: 99, t: Date.now(), members: [] } });
  first.socket.send('2');
  first.socket.frame('rc', { a: 1, n: '房主', b: 1, c: 1, d: '', o: 0 });           // told by an event, as one already there
  assert.deepEqual(first.history().map(e => e.type), ['here']);

  first.dispose();
  const again = loadLate({ reuse: first });
  again.socket.send('2');
  again.socket.frame('rc', { a: 1, n: '房主', b: 1, c: 1, d: '', o: 0 });
  assert.deepEqual(again.history().map(e => e.type), ['here'], 'the same one, once');
});

test('started again, a change since the last time is written: back online, or gone offline', () => {
  const first = loadLate({ snapshot: { room: 'LATE', self: 99, t: Date.now(), members: people } });
  first.socket.send('2');                                     // 房主 online, 掉线的 offline
  assert.deepEqual(first.history().map(e => [e.type, e.name]), [['here', '房主'], ['here', '掉线的']]);

  first.dispose();
  const flipped = people.map(m => (m.id === 1 ? { ...m, online: false } : m.id === 2 ? { ...m, online: true } : m));
  first.storage.data[MEMBERS_KEY] = JSON.stringify({ room: 'LATE', self: 99, t: Date.now(), members: flipped });
  const again = loadLate({ reuse: first });
  again.socket.send('2');
  assert.deepEqual(again.history().slice(2).map(e => [e.type, e.name]), [['offline', '房主'], ['online', '掉线的']]);
});

test('started again while somebody is offline, as the last thing written of them says, nothing is written', () => {
  const online = { room: 'LATE', self: 99, t: Date.now(), members: [{ id: 1, name: '房主', owner: true, online: true }] };
  const first = loadLate({ snapshot: online });
  first.socket.send('2');
  first.socket.frame('ro', { a: 1 });                          // went offline: written as that
  assert.deepEqual(first.history().map(e => e.type), ['here', 'offline']);

  first.dispose();
  first.storage.data[MEMBERS_KEY] = JSON.stringify({ ...online, t: Date.now(), members: [{ id: 1, name: '房主', owner: true, online: false }] });
  const again = loadLate({ reuse: first });
  again.socket.send('2');
  assert.deepEqual(again.history().map(e => e.type), ['here', 'offline'], 'still offline: no news');
});

test('what the plugin shows is not spoken: no 我, 咱, 您, 你, 他, 她 in the texts it displays (names and labels, like the app\'s own)', () => {
  const shown = [manifest.description, manifest.displayName, ...manifest.modkit.settings.flatMap(setting => [setting.title, setting.description])];
  const code = (mainSource + panelSource).split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  const strings = [...code.matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)].map(match => match[1] ?? match[2]).filter(text => /[\u4e00-\u9fff]/.test(text));
  for (const text of [...shown.filter(Boolean), ...strings]) {
    assert.ok(!/[我咱您你她]|(?<!其)他/.test(text.replace(/我自己|我勒个豆/g, '')), `a person word in "${text}"`);
  }
});

// --- found by the review ------------------------------------------------------------------------------------

test('the panel closed: its list is not copied as if it were current, what was copied is marked old once, and it is copied again when it is open', async () => {
  const { room, tree } = roomTree(PROPS());
  const shown = { open: true, fails: false, asked: [] };
  const panel = loadPanel(null, { vue: tree, shown });
  await sleep(60);
  const written = () => JSON.parse(panel.storage.data[MEMBERS_KEY]);
  assert.equal(written().members.length, 3, 'open: copied');
  assert.deepEqual(shown.asked[0], ['plugin:window|is_visible', { label: 'panel' }], 'asks the panel window, and only that');

  shown.open = false;                                         // the panel is closed: the app stops telling it
  await sleep(100);
  assert.deepEqual([written().t, written().members, written().self, written().room], [0, [], 99, 'ROOM1'], 'marked old; who the person is stays');

  room.props.roomMembers = [];                                // whatever the frozen panel holds changes or not
  const old = panel.storage.data[MEMBERS_KEY];
  await sleep(400);
  assert.equal(panel.storage.data[MEMBERS_KEY], old, 'nothing is written while it is closed, however long');

  shown.open = true;
  room.props.roomMembers = PROPS().roomMembers;
  await sleep(100);
  assert.equal(written().members.length, 3, 'open again: copied again');
  assert.ok(written().t > 0);
});

test('if the window cannot be asked whether the panel is shown, it is taken as open', async () => {
  const { tree } = roomTree(PROPS());
  const panel = loadPanel(null, { vue: tree, shown: { open: false, fails: true, asked: [] } });
  await sleep(60);
  assert.equal(JSON.parse(panel.storage.data[MEMBERS_KEY]).members.length, 3);
});

test('a copy of the panel\'s list does not bring back somebody who was seen leaving', async () => {
  const snapshot = () => ({ room: 'LATE', self: 99, t: Date.now(), members: [{ id: 1, name: '房主', owner: true, online: true }] });
  const late = loadLate({ snapshot: snapshot() });
  late.socket.send('2');
  late.socket.frame('rl', { a: 1 });
  assert.deepEqual(late.history().map(e => e.type), ['here', 'leave']);
  late.say(snapshot());                                       // the panel, closed since, still has them
  assert.deepEqual(late.history().map(e => e.type), ['here', 'leave'], 'not "here" again');
  await sleep(150);                                           // past the first moments after it was picked up
  late.socket.frame('rj', { a: 1, n: '房主' });               // but if they come back, the connection says so
  assert.deepEqual(late.history().map(e => e.type), ['here', 'leave', 'join']);
});

test('a room that is closed has its end written once: the connection that ends with it is not a leaving as well', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  socket.frame('rs', { r: 'V3f9IQD1f' });
  socket.deliver('close');
  await sleep(300);
  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in', 'dismiss']);
});

test('a room closed message for another room is ignored, as the app ignores it', () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  socket.frame('rs', { r: 'SOMEWHERE-ELSE' });
  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in']);
  socket.frame('rs', { r: 'V3f9IQD1f' });
  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in', 'dismiss']);
});

test('tries to come back that never open are not leavings, and the one leaving is dated at the loss', async () => {
  const run = load();
  const first = run.connect();
  first.deliver('open');
  const lost = Date.now();
  first.deliver('close');
  await sleep(40);
  for (let i = 0; i < 3; i += 1) {                            // the app tries again and again; none gets through
    const attempt = run.connect();
    attempt.deliver('close');
    await sleep(20);
  }
  await sleep(300);
  const outs = run.history().filter(entry => entry.type === 'me-out');
  assert.equal(outs.length, 1, 'one leaving');
  assert.ok(outs[0].t - lost < 30, 'dated at the loss, not at the last try');

  const refused = load();
  const never = refused.connect(ROOM_URL('NEVER'));
  never.deliver('close');
  await sleep(300);
  assert.deepEqual(refused.history(), [], 'a room that was never entered is not left');
});

test('the person themselves, once the panel has said who they are, is taken out of what was written before', () => {
  const storage = makeStorage({
    'modkit-room-history': JSON.stringify([
      { t: 1, room: 'R', type: 'me-in' },
      { t: 2, room: 'R', type: 'here', id: 99, name: '我自己' },
      { t: 3, room: 'R', type: 'here', id: 1, name: '别人' },
      { t: 4, room: 'R', type: 'join', id: 99, name: '我自己' },
    ]),
    [MEMBERS_KEY]: JSON.stringify({ room: 'R', self: 99, t: 0, members: [] }),
  });
  const run = load({ storage });
  assert.deepEqual(run.history().map(e => [e.type, e.id ?? null]), [['me-in', null], ['here', 1]]);
  assert.equal(run.live.count, '2 条');
});

test('what the app calls details is read as the app reads it: a number for the id, "a" and "o" alone is something else', () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  socket.frame('rc', { a: 5 });                              // a number and nothing else: details, with no nickname
  socket.frame('rc', { a: 6, o: 1 });                        // a and o and nothing else: not details
  socket.frame('rc', { a: '7', n: '按键' });                  // text: who pressed a key
  socket.frame('rj', { a: '8', n: '文本编号' });              // the app cannot read an rj with a text id either
  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in', 'here']);
  assert.equal(run.history()[1].id, 5);
  assert.match(run.warnings.join('\n'), /没能读懂 rj/);
});

test('a damaged record in the history does not stop a leave from being written', () => {
  const run = load({ storage: makeStorage({ 'modkit-room-history': JSON.stringify([{ t: 1, room: 'R', type: 'join', id: 3, name: '丙' }, null, 5]) }) });   // the damaged ones are the newest: they are looked at first
  const socket = run.connect();
  socket.deliver('open');
  assert.doesNotThrow(() => socket.frame('rl', { a: 3 }));
  assert.equal(run.history().at(-1).type, 'leave');
  assert.equal(run.history().at(-1).name, '丙');
});

test('the window closing ends what is open at once: there is no time for the wait', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  for (const [type, fn] of run.listeners) if (type === 'pagehide') fn({});
  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in', 'me-out'], 'written at once');
  socket.deliver('close');                                    // and the close that follows is not a second one
  await sleep(300);
  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in', 'me-out']);

  const waiting = load();
  const second = waiting.connect();
  second.deliver('open');
  second.deliver('close');                                    // a leaving that is waiting out its grace
  for (const [type, fn] of waiting.listeners) if (type === 'pagehide') fn({});
  assert.deepEqual(waiting.history().map(e => e.type), ['me-in', 'me-out'], 'the wait is cut short');
});

test('switched off, WebSocket is as it was: send, onopen, onmessage, onclose; and a leaving that was waiting is not written afterwards', async () => {
  const run = load();
  const proto = run.WebSocket.prototype;
  const socket = run.connect();
  socket.deliver('open');
  socket.deliver('close');                                    // waiting out the grace
  run.dispose();
  assert.equal(proto.send, run.before.send, 'send is the original function');
  for (const name of ['onopen', 'onmessage', 'onclose']) {
    const now = Object.getOwnPropertyDescriptor(proto, name);
    assert.equal(now.get, run.before[name].get, `${name}: the original getter`);
    assert.equal(now.set, run.before[name].set, `${name}: the original setter`);
  }
  await sleep(300);
  assert.deepEqual(kinds(run).map(k => k[0]), ['me-in'], 'the timer does not write after the plugin is off');
});

test('the dialog: a room closed and then "left" by its connection is one visit, and a leaving written twice is one', () => {
  const panel = loadPanel([
    { t: at(29, 9, 0), room: 'DDD', type: 'me-in' },
    { t: at(29, 9, 30), room: 'DDD', type: 'dismiss' },
    { t: at(29, 9, 30, 8), room: 'DDD', type: 'me-out' },       // what older versions wrote after a dismiss
    { t: at(29, 10, 0), room: 'EEE', type: 'me-in' },
    { t: at(29, 10, 20), room: 'EEE', type: 'me-out' },
    { t: at(29, 10, 20, 5), room: 'EEE', type: 'me-out' },
  ]);
  assert.deepEqual(panel.titles().filter(t => t.startsWith('房间号')), ['房间号 EEE', '房间号 DDD'], 'two rooms, two rows');
  assert.equal(panel.row('房间号 DDD').description, '10-29 09:00:00 到 09:30:00 · 待了 30 分钟 · 房间被解散');
});

test('how long and until when: across midnight, in hours, and under a minute', () => {
  const panel = loadPanel([
    { t: at(29, 23, 50), room: 'A', type: 'me-in' }, { t: at(30, 0, 20), room: 'A', type: 'me-out' },
    { t: at(30, 1, 0), room: 'B', type: 'me-in' }, { t: at(30, 3, 30), room: 'B', type: 'me-out' },
    { t: at(30, 4, 0), room: 'C', type: 'me-in' }, { t: at(30, 7, 0), room: 'C', type: 'me-out' },
    { t: at(30, 8, 0), room: 'D', type: 'me-in' }, { t: at(30, 8, 0, 20), room: 'D', type: 'me-out' },
  ]);
  assert.equal(panel.row('房间号 A').description, '10-29 23:50:00 到 10-30 00:20:00 · 待了 30 分钟', 'the other day is written in full');
  assert.equal(panel.row('房间号 B').description, '10-30 01:00:00 到 03:30:00 · 待了 2 小时 30 分钟');
  assert.equal(panel.row('房间号 C').description, '10-30 04:00:00 到 07:00:00 · 待了 3 小时');
  assert.equal(panel.row('房间号 D').description, '10-30 08:00:00 到 08:00:20 · 待了 不到 1 分钟');
});

// --- the 联机 page ---------------------------------------------------------------------------------------------

// Elements enough for the section: a class, a text, children, listeners, a disabled flag.
function fakeElement(tag) {
  return {
    tag, className: '', textContent: '', disabled: false, type: '', children: [], handlers: [],
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    remove() { this.removed = true; },
    addEventListener(type, fn) { if (type === 'click') this.handlers.push(fn); },
    press() { this.handlers.forEach(fn => fn()); },
    find(predicate) { return [this, ...this.children.flatMap(child => child.find?.(predicate) ?? [])].filter(predicate); },
    text() { return [this.textContent, ...this.children.map(child => child.text?.() ?? '')].join(' ').replace(/\s+/g, ' ').trim(); },
  };
}

function loadPage(entries, { here = null } = {}) {
  const storage = makeStorage(entries ? { 'modkit-room-history': JSON.stringify(entries) } : {});
  const commands = [];
  const mounts = [];
  const watchers = [];
  const removed = [];
  const sheets = [];
  const disposers = [];
  const mod = {
    entry: () => () => {},
    onDispose: fn => { disposers.push(fn); running.push({ dispose: fn }); },
    css: text => { sheets.push(text); return () => sheets.splice(sheets.indexOf(text), 1); },
    app: { action: async (type, payload) => { commands.push({ type, ...payload }); } },
    page: {
      onComponent(name, fn) {
        const watcher = { name, fn, cleanup: null };
        watchers.push(watcher);
        return () => { watcher.cleanup?.(); watcher.cleanup = null; };
      },
      mount(target, node) { mounts.push({ target, node }); return () => removed.push(target); },
    },
  };
  const window = { modkit: { changed() {}, live: new Map([['room-history', new Map(here ? [['room', here]] : [])]]) }, addEventListener() {}, removeEventListener() {} };
  const document = { createElement: tag => fakeElement(tag), querySelector: () => null };
  const navigator = { clipboard: { writeText: () => Promise.resolve() } };
  new AsyncFunction('mod', 'localStorage', 'window', 'document', 'navigator', panelFast)(mod, storage, window, document, navigator);
  return {
    commands, mounts, removed, sheets, watchers, storage,
    // the app draws the room page: the component appears
    appears() { const watcher = watchers.find(w => w.name === 'MainPanelRoomTab'); watcher.cleanup = watcher.fn({ name: 'MainPanelRoomTab', el: {}, props: {} }); },
    section: () => mounts.find(m => m.target === '.room-module .panel-content')?.node,
    dispose: () => disposers.forEach(fn => fn()),
  };
}

test('the 联机 page gets the list, under the members: one row for each room, from the page\'s own classes', () => {
  const page = loadPage(HISTORY, { here: null });
  assert.equal(page.watchers.length, 1);
  assert.equal(page.watchers[0].name, 'MainPanelRoomTab', 'it waits for the page to be drawn');
  assert.equal(page.mounts.length, 0, 'nothing before then');
  page.appears();
  const section = page.section();
  assert.ok(section, 'mounted into the page\'s content');
  assert.equal(section.className, 'wrh-section');
  const [header, list] = section.children;
  assert.equal(header.className, 'room-info');
  assert.equal(header.children[0].textContent, '房间历史');
  assert.equal(header.children[1].textContent, '共 2 个房间，9 条记录');
  assert.equal(list.className, 'room-members common-scrollbar2', 'the own list and scrollbar classes of the app');
  assert.match(page.sheets.join(''), /.wrh-section .room-members {[^}]*overflow-y: auto/, 'it is the list that scrolls');
  assert.match(page.sheets.join(''), /.room-module .panel-content { display: flex; flex-direction: column; }/, 'in a column that gives it the rest of the height');
  const rows = list.children;
  assert.equal(rows.length, 2, 'both closed: one row each, the newest first');
  assert.equal(rows[0].children[0].textContent, '房间号 BBB');
  assert.equal(rows[0].children[1].textContent, '10-29 16:00:00 · 1 人 · 没有记录到离开');
  assert.equal(rows[1].children[0].textContent, '房间号 AAA');
  assert.equal(rows[1].children[1].textContent, '10-29 14:00:00 到 14:45:00 · 3 人 · 待了 45 分钟');
  assert.match(page.sheets.join(''), /\.wrh-section/, 'with its own stylesheet');
});

test('on the 联机 page: 进入 puts the number in the page\'s box and joins, and is not there while the person is in a room', async () => {
  const out = loadPage(HISTORY, { here: null });
  out.appears();
  const row = out.section().children[1].children[1];                       // AAA
  const enter = row.find(node => node.textContent === '进入')[0];
  assert.ok(enter, 'a room that is not the one the person is in can be entered');
  enter.press();
  await sleep(300);
  assert.deepEqual(out.commands, [{ type: 'set-room-id-input', value: 'AAA' }, { type: 'join-room' }], 'the number first, then the page\'s own join');
  assert.equal(enter.textContent, '已发出');

  const inRoom = loadPage(HISTORY, { here: 'BBB' });
  inRoom.appears();
  const buttons = inRoom.section().find(node => node.tag === 'button').map(node => node.textContent);
  assert.ok(!buttons.includes('进入'), 'in a room the page cannot join another');
  assert.ok(buttons.includes('复制') && buttons.includes('展开'));
});

test('on the 联机 page: 展开 shows what happened in the room, and 收起 closes it again', () => {
  const page = loadPage(HISTORY, { here: null });
  page.appears();
  const open = () => page.section().children[1].children;
  const toggle = () => open()[1].find(node => node.textContent === '展开')[0];                   // the row of AAA
  assert.equal(open().length, 2);
  toggle().press();
  assert.ok(open().length > 2, 'the events are rows of their own, under the room');
  assert.ok(open().some(row => row.className === 'wrh-event' && /小明 离开了房间/.test(row.text())));
  assert.ok(page.section().find(node => node.textContent === '收起').length >= 1);
});

test('on the 联机 page: with nothing recorded it says so, and when the page goes or the plugin stops, the section goes', () => {
  const page = loadPage([], { here: null });
  page.appears();
  assert.match(page.section().text(), /还没有记录/);
  page.watchers[0].cleanup();                                                // the page is drawn away
  assert.equal(page.removed.length, 1, 'taken out with it');
  page.dispose();
  assert.equal(page.sheets.length, 0, 'and its stylesheet');
  assert.equal(page.section().removed, true);
});

test('a loader without pages (no mod.page) leaves the list in the plugin\'s dialog as it was', () => {
  const panel = loadPanel(HISTORY, { here: 'BBB' });
  assert.deepEqual(panel.titles(), ['清空记录', '房间号 BBB', '　路人 进入了房间', '房间号 AAA']);
});

// --- the app coming back to a room it was in ---------------------------------------------------------------------
// Seen on the real app: the same room, 12 "stays" in an afternoon. Every time the app was started again, or its page
// loaded again (an update of a plugin, the loader), the connection to the room was new, and each one began a visit
// that the one before had no end for.

const ROOM = 'V3f9IQD1f';
const seeded = (entries, extra = {}) => makeStorage({ 'modkit-room-history': JSON.stringify(entries), ...extra });

test('the app coming back to the room it was just in is the same stay: no second beginning', async () => {
  const now = Date.now();
  const storage = seeded([{ t: now - 60_000, room: ROOM, type: 'me-in' }, { t: now - 100, room: ROOM, type: 'here', id: 5, name: '甲' }]);
  const run = load({ storage });
  run.connect().deliver('open');
  await sleep(20);
  assert.deepEqual(run.history().map(e => e.type), ['me-in', 'here'], 'nothing added: still one stay');
  assert.equal(run.live.room, ROOM);
});

test('and the people it is told are in the room are not written as "already there" a second time', async () => {
  const now = Date.now();
  const storage = seeded([{ t: now - 60_000, room: ROOM, type: 'me-in' }, { t: now - 100, room: ROOM, type: 'here', id: 5, name: '甲' }]);
  const run = load({ storage });
  const socket = run.connect();
  socket.deliver('open');
  socket.frame('rc', { a: 5, n: '甲', b: 1, c: 1 });
  await sleep(20);
  assert.deepEqual(run.history().map(e => e.type), ['me-in', 'here']);
});

test('a stay that was not ended and is not come back to in time ended when the person was last seen there', async () => {
  const now = Date.now();
  const storage = seeded([{ t: now - 3_600_000, room: ROOM, type: 'me-in' }, { t: now - 3_000_000, room: ROOM, type: 'join', id: 5, name: '甲' }]);
  const run = load({ storage });
  run.connect().deliver('open');
  await sleep(20);
  const entries = run.history();
  assert.deepEqual(entries.map(e => e.type), ['me-in', 'join', 'me-out', 'me-in']);
  assert.equal(entries[2].t, now - 3_000_000, 'ended at the last record of the room: that is the last it is known to be there');
});

test('the last time the person was seen in the room counts, and not only the last record: a quiet room is not a left one', async () => {
  const now = Date.now();
  const storage = seeded([{ t: now - 3_600_000, room: ROOM, type: 'me-in' }], { 'modkit-room-history-alive': JSON.stringify({ room: ROOM, t: now - 150 }) });
  const run = load({ storage });
  run.connect().deliver('open');
  await sleep(20);
  assert.deepEqual(run.history().map(e => e.type), ['me-in'], 'seen a moment ago: the same stay, though the last record is an hour old');
});

test('while in a room, the time it was last there is kept', async () => {
  const run = load();
  run.connect().deliver('open');
  await sleep(20);
  const first = JSON.parse(run.storage.data['modkit-room-history-alive']);
  assert.equal(first.room, ROOM);
  await sleep(120);
  assert.ok(JSON.parse(run.storage.data['modkit-room-history-alive']).t > first.t, 'written again');
});

test('the app shut and started again: the closing is taken back when it comes to the room again soon', async () => {
  const first = load();
  first.connect().deliver('open');
  await sleep(20);
  for (const [type, fn] of first.listeners) if (type === 'pagehide') fn();
  assert.deepEqual(first.history().map(e => e.type), ['me-in', 'me-out']);
  assert.equal(first.history()[1].closed, true, 'said to be the app shut, not the room left');
  first.dispose();

  const second = load({ storage: first.storage });
  second.connect().deliver('open');
  await sleep(20);
  assert.deepEqual(second.history().map(e => e.type), ['me-in'], 'one stay');
});

test('leaving the room and coming in again is two stays, however soon', async () => {
  const run = load();
  const socket = run.connect();
  socket.deliver('open');
  await sleep(20);
  socket.deliver('close');
  await sleep(250);                                          // the wait is over: it was a leaving
  assert.deepEqual(run.history().map(e => e.type), ['me-in', 'me-out']);
  assert.equal(run.history()[1].closed, undefined);
  run.connect().deliver('open');
  await sleep(20);
  assert.deepEqual(run.history().map(e => e.type), ['me-in', 'me-out', 'me-in']);
});

test('another room is another stay: the one it was in is ended', async () => {
  const now = Date.now();
  const storage = seeded([{ t: now - 500, room: 'other', type: 'me-in' }]);
  const run = load({ storage });
  run.connect().deliver('open');
  await sleep(20);
  assert.deepEqual(run.history().map(e => [e.room, e.type]), [['other', 'me-in'], [ROOM, 'me-in']]);
});
