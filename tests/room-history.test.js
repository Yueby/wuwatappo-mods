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

test('it only listens: the one permission is the clipboard (for 复制), no network, no call of the app, and the history stays here', () => {
  assert.deepEqual(manifest.modkit.permissions, ['clipboard']);
  assert.equal(manifest.modkit.host, undefined, 'no Node part');
  const code = (mainSource + panelSource).replace(/\/\/.*$/gm, '');
  assert.ok(!/fetch\(|XMLHttpRequest|invoke\(|new WebSocket|\.emit\(/.test(code), 'it does not send or call anything');
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

function loadPanel(entries, { here = null, clipboard = { writes: [], fails: false }, vue = null } = {}) {
  const storage = makeStorage(entries ? { 'modkit-room-history': typeof entries === 'string' ? entries : JSON.stringify(entries) } : {});
  const rows = [];
  let redraws = 0;
  const disposers = [];
  const mod = {
    entry: def => { rows.push(def); return () => rows.splice(rows.indexOf(def), 1); },
    onDispose: fn => { disposers.push(fn); running.push({ dispose: fn }); },
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
  assert.equal(panel.row('　早到的 掉线了').description, '至少待了 40 分钟（我进房时他已经在）', 'he was already there: it is a longer time than it says');
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
