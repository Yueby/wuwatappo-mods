// Room history: writes down who comes into and goes out of the room the pet is in, with the room number and
// the time. What it shows on the MOD page is in package.json and panel.js; the history is kept in
// localStorage, which all the app's windows share, under STORE, so it is there after a restart.
//
// It only listens. It reads what the app's own room connection receives and sends nothing, to anyone: the
// history never leaves this computer. (It adds no permission for that reason.)
//
// How the app does it (read from the 1.0.2 main-window bundle): the room is a socket.io connection to
// wss://api-mc-wuwatappo.kurogames-global.com/socket.io/?token=…&rm=<room number>&EIO=3. Every message is a
// text frame, `42["<event>",{…}]`. The ones about people are
//     rj  {a: id, n: nickname, …}   somebody came in
//     rc  {a: id, n: nickname, …}   a member's details (also how the ones already there are told to a newcomer)
//     rl  {a: id}                   somebody left
//     ro  {a: id}                   somebody went offline (still in the room)
//     rs  {r: room number}          the room was closed
// (`rc` with a text `a`, "95007|99051", is who pressed a key, and `rc` with only `a` and `o` is something
// else again: neither says who is in the room.) A leave names an id and not a nickname, so the nickname is
// remembered from when the person came in.
//
// The app builds its socket from a copy of WebSocket it took when it started, so replacing WebSocket would
// miss it. What it does with every socket is set `onopen`, `onmessage` and `onclose`, and send a ping now
// and then; those are on WebSocket.prototype, and they are wrapped here: a socket is picked up when the app
// sets its handlers, or, for one that was already open when this started, at its next ping.

const STORE = 'modkit-room-history';
const SETTLE_MS = 3000;           // the people already in a room are told to a newcomer in its first moments: they were there, they did not come in
const LEAVE_GRACE_MS = 8000;      // a connection that drops and comes back to the same room is not leaving it

let alive = true;
const taps = new WeakMap();       // socket -> what is known of the room it is for
let current = null;               // the session whose room is shown on the MOD page
let pendingLeave = null;          // { room, timer }: the room the person has just lost the connection to

const proto = WebSocket.prototype;
const originals = { send: proto.send };
for (const name of ['onopen', 'onmessage', 'onclose']) originals[name] = Object.getOwnPropertyDescriptor(proto, name);

// --- the history ----------------------------------------------------------------------------------------

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function showCount(list) {
  mod.live('count', `${list.length} 条`);
}

function record(entry) {
  const list = read();
  list.push({ t: Date.now(), ...entry });
  const max = Number(mod.config.get('max')) || 300;
  while (list.length > max) list.shift();
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch (err) {
    mod.warn(`没能保存房间历史：${err.message}`);
    return;
  }
  showCount(list);
}

// The last nickname this id had, from this session or the history.
function nameOf(session, id) {
  const known = session.members.get(id)?.name;
  if (known) return known;
  const before = read().reverse().find(entry => entry.id === id && entry.name);
  return before?.name ?? `玩家 ${id}`;
}

// --- what a frame says ----------------------------------------------------------------------------------

// `42["rj",{…}]`, or with the number of an acknowledgement before the bracket: [event, payload], or null.
function parseFrame(data) {
  if (typeof data !== 'string') return null;
  const found = /^42\d*(\[[\s\S]*\])\s*$/.exec(data);
  if (!found) return null;
  try {
    const [event, payload] = JSON.parse(found[1]);
    return typeof event === 'string' ? { event, payload } : null;
  } catch {
    return null;
  }
}

// A member's id, as the app reads one (a number, or a number in text); 0 when it is not one.
function idOf(value) {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : 0;
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function nameIn(payload) {
  return typeof payload?.n === 'string' && payload.n.trim() ? payload.n.trim() : '';
}

// The log (the MOD page's 日志) is how a difference between what this mod expects and what the app sends
// is found: the first message of each kind is written as it came, and one that cannot be read is said so,
// a few times and not more.
const shown = new Set();
let unclear = 0;
const MAX_UNCLEAR = 10;
const excerpt = payload => { try { return JSON.stringify(payload).slice(0, 200); } catch { return String(payload); } };

function sample(event, payload) {
  if (shown.has(event)) return;
  shown.add(event);
  mod.log(`第一次收到 ${event}：${excerpt(payload)}`);
}

function cannotRead(event, payload) {
  unclear += 1;
  if (unclear <= MAX_UNCLEAR) mod.warn(`没能读懂 ${event}：${excerpt(payload)}${unclear === MAX_UNCLEAR ? '（后面的不再提示）' : ''}`);
}

// Somebody the room has told about: new, or one already known whose details came again.
function seen(session, event, payload) {
  const id = idOf(payload?.a);
  if (!id) return cannotRead(event, payload);
  const name = nameIn(payload);
  const member = session.members.get(id);

  if (member) {
    if (name) member.name = name;
    if (!member.online) {                             // back from offline
      member.online = true;
      record({ room: session.room, type: 'online', id, name: member.name || nameOf(session, id) });
    }
    return;
  }

  session.members.set(id, { name, online: true });
  const already = Date.now() - session.since < SETTLE_MS || (event === 'rc' && session.adopted);
  record({ room: session.room, type: already ? 'here' : 'join', id, name: name || nameOf(session, id) });
}

function handle(session, { event, payload }) {
  if (event === 'rj') {
    sample(event, payload);
    seen(session, event, payload);
  } else if (event === 'rc') {
    // Only the form that carries a member's details: not who pressed a key ("a" as text), not the one with
    // nothing but `a` and `o`.
    if (payload && typeof payload === 'object' && typeof payload.a !== 'string' && Object.keys(payload).some(key => key !== 'a' && key !== 'o')) {
      sample(event, payload);
      seen(session, event, payload);
    }
  } else if (event === 'rl') {
    sample(event, payload);
    const id = idOf(payload?.a);
    if (!id) return cannotRead(event, payload);
    record({ room: session.room, type: 'leave', id, name: nameOf(session, id) });
    session.members.delete(id);
  } else if (event === 'ro') {
    sample(event, payload);
    const id = idOf(payload?.a);
    if (!id) return cannotRead(event, payload);
    const member = session.members.get(id);
    if (member?.online === false) return;             // told twice: nothing to say
    if (member) member.online = false;
    record({ room: session.room, type: 'offline', id, name: nameOf(session, id) });
  } else if (event === 'rs') {
    sample(event, payload);
    record({ room: session.room, type: 'dismiss' });
    session.members.clear();
  }
}

// --- the connection -------------------------------------------------------------------------------------

function roomOf(url) {
  try {
    return new URL(url).searchParams.get('rm')?.trim() ?? '';
  } catch {
    return '';
  }
}

function show(session) {
  current = session;
  mod.live('room', session?.room || '不在房间里');
}

function opened(session) {
  if (!session.room) return;
  show(session);
  if (pendingLeave?.room === session.room) {          // the same room again: it was a dropped connection
    clearTimeout(pendingLeave.timer);
    pendingLeave = null;
    return;
  }
  record({ room: session.room, type: 'me-in' });
}

// The leaving of the room the connection was lost to, written now instead of when the wait is over. It is
// dated when the connection was lost, not when the wait ended: that is when the person was gone.
function settleLeave() {
  if (!pendingLeave) return;
  const { room, timer, at } = pendingLeave;
  clearTimeout(timer);
  pendingLeave = null;
  record({ t: at, room, type: 'me-out' });
}

function closed(session) {
  if (!session.room) return;
  if (current === session) show(null);
  if (pendingLeave?.room !== session.room) settleLeave();      // another room's leaving that is still waiting: its wait is over
  clearTimeout(pendingLeave?.timer);
  const pending = { room: session.room, timer: null, at: Date.now() };
  pending.timer = setTimeout(() => {
    if (pendingLeave === pending) pendingLeave = null;
    if (alive) record({ t: pending.at, room: pending.room, type: 'me-out' });
  }, LEAVE_GRACE_MS);
  pendingLeave = pending;
}

// Listen to a socket of the app's room, once. `open`: it is already open (it was picked up late).
function tap(socket, open = false) {
  if (!alive || taps.has(socket)) return;
  if (!/\/socket\.io\//.test(String(socket.url))) return;      // some other connection
  const session = { room: roomOf(socket.url), members: new Map(), since: Date.now(), adopted: open };
  taps.set(socket, session);

  socket.addEventListener('message', event => {
    if (!alive) return;
    const frame = parseFrame(event.data);
    if (frame && session.room) handle(session, frame);
  });
  socket.addEventListener('close', () => { if (alive) closed(session); });
  if (open) {
    if (session.room) show(session);                           // it is not a coming in: it was there already
  } else {
    socket.addEventListener('open', () => { if (alive) opened(session); });
  }
}

for (const name of ['onopen', 'onmessage', 'onclose']) {
  const original = originals[name];
  if (!original?.set) continue;
  Object.defineProperty(proto, name, {
    ...original,
    set(handler) {
      tap(this);
      original.set.call(this, handler);
    },
  });
}

proto.send = function send(...args) {
  tap(this, this.readyState === 1);
  return originals.send.apply(this, args);
};

// The panel can clear the history; the count shown has to follow.
const onStorage = event => {
  if (event.key === STORE || event.key === null) showCount(read());
};
window.addEventListener('storage', onStorage);

mod.onDispose(() => {
  alive = false;
  clearTimeout(pendingLeave?.timer);
  window.removeEventListener('storage', onStorage);
  proto.send = originals.send;
  for (const name of ['onopen', 'onmessage', 'onclose']) {
    if (originals[name]) Object.defineProperty(proto, name, originals[name]);
  }
});

showCount(read());
mod.live('room', '不在房间里');
