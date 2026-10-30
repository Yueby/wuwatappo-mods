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
// and who is in a room when the app comes into it is not an event: it is the answer to the app's own
// request for the room (an acknowledgement, `43<number>[…]`):
//     {c: 0, d: {r: room number, m: [{u: id, n: nickname, o: 1 if the owner, l: 1 if online}, …]}}
// Those are the ones "already there". A plugin that starts while the app is in a room has missed that answer,
// and the app is not asked again (that would be calling the server on its behalf). What is there to read is the
// app's own panel, which holds the same list for the 联机 page: panel.js copies it, with the room number and
// the person's own id, into localStorage under MEMBERS_KEY, and this reads it from there (see reconcile). The
// panel only gets the room from the app while it is open: panel.js does not write while it is closed, and a copy
// older than FRESH_MS is not believed.
// (`rc` with a text `a`, "95007|99051", is who pressed a key, and `rc` with only `a` and `o` is something
// else again: neither says who is in the room.) A leave names an id and not a nickname, so the nickname is
// remembered from when the person came in.
//
// The app builds its socket from a copy of WebSocket it took when it started, so replacing WebSocket would
// miss it. What it does with every socket is set `onopen`, `onmessage` and `onclose`, and send a ping now
// and then; those are on WebSocket.prototype, and they are wrapped here: a socket is picked up when the app
// sets its handlers, or, for one that was already open when this started, at its next ping.

const STORE = 'modkit-room-history';
const MEMBERS_KEY = 'modkit-room-history-members';   // written by panel.js: { room, self, members: [{ id, name, owner, online }], t }
const FRESH_MS = 30_000;          // a copy of the panel's list older than this is not believed (see panel.js, which refreshes it)
const SETTLE_MS = 3000;           // the people already in a room are told to a newcomer in its first moments: they were there, they did not come in
const LEAVE_GRACE_MS = 8000;      // a connection that drops and comes back to the same room is not leaving it
const BEAT_MS = 20_000;           // in a room, the time it was last seen there is written this often (ALIVE_KEY)
const RECONNECT_MS = 180_000;     // the app coming back to a room within this long of when it was last there is the same stay
const ALIVE_KEY = 'modkit-room-history-alive';   // { room, t }: the last time the person was seen in a room

let alive = true;
const taps = new WeakMap();       // socket -> what is known of the room it is for
let current = null;               // the session whose room is shown on the MOD page
let pendingLeave = null;          // { room, timer, at, members }: the room the person has just lost the connection to
let selfId = 0;                   // the person's own id, once the panel has said it: they are in the room, they are not "somebody"

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

// Said by the panel: who the person is. They are in every room they are in, and "came in" and "left" are written
// for them from the connection, so nothing else about them belongs in the history. If some was written before
// they were known (the first room after the plugin was installed), it is taken out now.
function learnSelf(id) {
  if (!id || id === selfId) return;
  selfId = id;
  const list = read();
  const rest = list.filter(entry => entry?.id !== id);
  if (rest.length === list.length) return;
  try {
    localStorage.setItem(STORE, JSON.stringify(rest));
    showCount(rest);
  } catch {
    // the next write tries again
  }
}

function writeList(list) {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch (err) {
    mod.warn(`没能保存房间历史：${err.message}`);
    return false;
  }
  showCount(list);
  return true;
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

// The last nickname this id had: from this session, the panel's list of the room, or the history.
function nameOf(session, id) {
  const known = session.members.get(id)?.name;
  if (known) return known;
  const panel = Array.isArray(snapshotOf()?.members) ? snapshotOf().members.find(member => idOf(member?.id) === id && typeof member.name === 'string' && member.name.trim()) : null;
  if (panel) return panel.name.trim();
  const before = read().reverse().find(entry => entry?.id === id && entry.name);
  return before?.name ?? `玩家 ${id}`;
}

// What the history last says about a stay in a room: its last me-in, me-out or dismiss, and where it is in the list.
function boundaryOf(room) {
  const list = read();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i];
    if (entry?.room === room && (entry.type === 'me-in' || entry.type === 'me-out' || entry.type === 'dismiss')) return { entry, index: i };
  }
  return null;
}

// The time of the last record of a room, whatever it is.
function lastRecordAt(room) {
  const list = read();
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i]?.room === room && Number.isFinite(list[i].t)) return list[i].t;
  return 0;
}

function readAlive() {
  try {
    const alive = JSON.parse(localStorage.getItem(ALIVE_KEY));
    return alive && typeof alive.room === 'string' && Number.isFinite(alive.t) ? alive : null;
  } catch {
    return null;
  }
}

// The person is in the room now: said down, so that a stay that was not ended (the app was closed with no time to
// write it) is known to have lasted until then, and not until the last somebody came or went.
function beat() {
  if (!alive || !current?.room || !(current.opened || current.adopted)) return;
  try {
    localStorage.setItem(ALIVE_KEY, JSON.stringify({ room: current.room, t: Date.now() }));
  } catch {
    // the next beat tries again
  }
}

// What the history last says of somebody in a room, in the visit that is going on: the record, or null when
// there is none (they were not written down, or the visit it was about is over, or it has not begun).
// This is what lets a plugin that is started again, or turned off and on, in the middle of a room, not write
// the same people down as "already there" a second time.
function lastOf(room, id) {
  const list = read();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i];
    if (entry?.room !== room) continue;
    if (entry.type === 'me-in' || entry.type === 'me-out' || entry.type === 'dismiss') return null;
    if (entry.id === id) return entry;
  }
  return null;
}

// --- what a frame says ----------------------------------------------------------------------------------

// `42["rj",{…}]`, or with the number of an acknowledgement before the bracket: { event, payload }, or null.
// An answer to a request, `43<number>[{…}]`, is { event: 'ack', payload: the answer }.
function parseFrame(data) {
  if (typeof data !== 'string') return null;
  const answer = /^43\d*(\[[\s\S]*\])\s*$/.exec(data);
  if (answer) {
    try {
      return { event: 'ack', payload: JSON.parse(answer[1])[0] };
    } catch {
      return null;
    }
  }
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
// Nicknames are not copied into the log: each is shown as 〇 for every character, so that the shape is there and
// the people are not.
const excerpt = payload => {
  try {
    return JSON.stringify(payload, (key, value) => (key === 'n' && typeof value === 'string' ? '〇'.repeat(value.length) : value)).slice(0, 300);
  } catch {
    return String(payload);
  }
};

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
  const id = typeof payload?.a === 'number' ? idOf(payload.a) : 0;        // the app reads these two with a number only
  if (!id) return cannotRead(event, payload);
  if (id === selfId) return;                          // "I came in" is written when the connection opens
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
  if (already && ['here', 'join', 'online'].includes(lastOf(session.room, id)?.type)) return;   // written already, before this was started again
  record({ room: session.room, type: already ? 'here' : 'join', id, name: name || nameOf(session, id) });
}

// Somebody who is in the room and was not seen coming in: they were there. Not the person themselves.
// `fromPanel`: the list is the panel's copy, which is only as new as the last time the panel was open. Somebody
// who has been seen leaving is not brought back by it: if they come back, an event says so.
function admit(session, id, name, { owner, online, fromPanel = false }) {
  if (!id || id === selfId) return;
  const known = session.members.get(id);
  if (known) {                                         // told already, by an event or an earlier list
    if (name) known.name = name;
    if (online && known.online === false) {            // the list says they are back
      known.online = true;
      record({ room: session.room, type: 'online', id, name: known.name || nameOf(session, id) });
    }
    return;
  }
  // Written down already, before this was started again? Then only what has changed since is news.
  const before = lastOf(session.room, id);
  if (fromPanel && before?.type === 'leave') return;
  session.members.set(id, { name, online });
  if (before && ['here', 'join', 'online', 'offline'].includes(before.type)) {
    const wasOffline = before.type === 'offline' || before.offline === true;
    if (online && wasOffline) record({ room: session.room, type: 'online', id, name: name || nameOf(session, id) });
    else if (!online && !wasOffline) record({ room: session.room, type: 'offline', id, name: name || nameOf(session, id) });
    return;
  }
  record({
    room: session.room,
    type: 'here',
    id,
    name: name || nameOf(session, id),
    ...(owner ? { owner: true } : {}),
    ...(online ? {} : { offline: true }),
  });
}

// The answer to the app's request for the room: everybody who is in it. They were there; nobody came in.
// Anything else the app is answered (it asks for other things) has no member list in it, and is not ours.
function roster(session, answer) {
  const list = answer?.d?.m;
  if (!Array.isArray(list) || typeof answer.d.r !== 'string') return;
  sample('名单', answer);
  for (const member of list) {
    const id = idOf(member?.u);
    if (!id) {
      cannotRead('名单', member);
      continue;
    }
    admit(session, id, nameIn(member), { owner: member.o === 1 || member.o === true, online: member.l === 1 || member.l === true });
  }
}

// `rc` as the app reads it: with a text `a` it is who pressed a key; with `a` and `o` and nothing else it is a
// third thing (Hg); any other object with a number for `a` is a member's details (Cd), nickname or not.
function isDetails(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.a === 'string') return false;
  return !('o' in payload && Object.keys(payload).every(key => key === 'a' || key === 'o'));
}

// What the panel holds of the room: the people in it, as the app shows them. It is the way to know who was
// there when this started in the middle of a room. Only believed for the room this connection is for, and
// when it is recent; whoever is already known is left as they are.
function snapshotOf() {
  try {
    const snap = JSON.parse(localStorage.getItem(MEMBERS_KEY));
    return snap && typeof snap === 'object' ? snap : null;
  } catch {
    return null;
  }
}

function reconcile(session) {
  const snap = snapshotOf();
  learnSelf(idOf(snap?.self));
  if (!session?.room || !snap || snap.room !== session.room || !Array.isArray(snap.members)) return;
  if (!(Date.now() - Number(snap.t) <= FRESH_MS)) return;
  for (const member of snap.members) {
    admit(session, idOf(member?.id), typeof member?.name === 'string' ? member.name.trim() : '', { owner: member?.owner === true, online: member?.online !== false, fromPanel: true });
  }
}

function handle(session, { event, payload }) {
  if (event === 'ack') {
    roster(session, payload);
  } else if (event === 'rj') {
    sample(event, payload);
    seen(session, event, payload);
  } else if (event === 'rc') {
    if (isDetails(payload)) {
      sample(event, payload);
      seen(session, event, payload);
    }
  } else if (event === 'rl') {
    sample(event, payload);
    const id = idOf(payload?.a);
    if (!id) return cannotRead(event, payload);
    if (id === selfId) return;
    record({ room: session.room, type: 'leave', id, name: nameOf(session, id) });
    session.members.delete(id);
  } else if (event === 'ro') {
    sample(event, payload);
    const id = idOf(payload?.a);
    if (!id) return cannotRead(event, payload);
    if (id === selfId) return;
    const member = session.members.get(id);
    if (member?.online === false) return;             // told twice: nothing to say
    if (member) member.online = false;
    record({ room: session.room, type: 'offline', id, name: nameOf(session, id) });
  } else if (event === 'rs') {
    sample(event, payload);
    const named = typeof payload?.r === 'string' ? payload.r.trim() : '';
    if (named && named !== session.room) return;      // about another room: the app ignores it too
    record({ room: session.room, type: 'dismiss' });
    session.members.clear();
    session.dismissed = true;                          // the connection ends after this: that is not a leaving to write down as well
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
  session.opened = true;
  show(session);
  if (pendingLeave?.room === session.room) {          // the same room again: it was a dropped connection
    clearTimeout(pendingLeave.timer);
    session.members = pendingLeave.members;           // the same people: the list that comes again is not them coming in
    pendingLeave = null;
    return;
  }
  // The app comes back to a room the history has the person in, or has just closed on them: it was started again, or
  // its page was loaded again, and the room is the same. That is the same stay, not one more: it is only the
  // connection that is new.
  const last = boundaryOf(session.room);
  const seen = Math.max(lastRecordAt(session.room), readAlive()?.room === session.room ? readAlive().t : 0);
  if (last?.entry.type === 'me-in') {
    if (Date.now() - seen <= RECONNECT_MS) {
      beat();
      return;
    }
    record({ t: seen, room: session.room, type: 'me-out' });         // the stay it was ended when it was last seen there
  } else if (last?.entry.type === 'me-out' && last.entry.closed && Date.now() - last.entry.t <= RECONNECT_MS) {
    const list = read();
    list.splice(last.index, 1);                                       // the closing of the app is taken back: the room was not left
    if (writeList(list)) {
      beat();
      return;
    }
  }
  record({ room: session.room, type: 'me-in' });
  beat();
}

// The leaving of the room the connection was lost to, written now instead of when the wait is over. It is
// dated when the connection was lost, not when the wait ended: that is when the person was gone.
function settleLeave(closedByApp = false) {
  if (!pendingLeave) return;
  const { room, timer, at } = pendingLeave;
  clearTimeout(timer);
  pendingLeave = null;
  record({ t: at, room, type: 'me-out', ...(closedByApp ? { closed: true } : {}) });      // `closed`: the app was shut, which may be taken back if it comes back
}

function closed(session) {
  if (!session.room || session.ended) return;
  session.ended = true;
  if (current === session) show(null);
  // A connection that never opened (a try at coming back that failed, a room that was refused) is not a leaving,
  // and one that is closed because the room was closed has had its end written already.
  if (!session.opened && !session.adopted) return;
  if (session.dismissed) return;
  if (pendingLeave?.room !== session.room) settleLeave();      // another room's leaving that is still waiting: its wait is over
  clearTimeout(pendingLeave?.timer);
  const pending = { room: session.room, timer: null, at: Date.now(), members: session.members };
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
    if (session.room) {                                        // it is not a coming in: it was there already
      show(session);
      beat();
      reconcile(session);
    }
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

// The panel can clear the history, and has the list of who is in the room: the count shown has to follow,
// and the list is read when it changes.
const onStorage = event => {
  if (event.key === STORE || event.key === null) showCount(read());
  if (alive && (event.key === MEMBERS_KEY || event.key === null)) reconcile(current);
};
window.addEventListener('storage', onStorage);

// The window closing (the app quitting) leaves no time for the wait: what is open is ended now.
const onPageHide = () => {
  if (!alive) return;
  if (current) closed(current);
  settleLeave(true);
};
window.addEventListener('pagehide', onPageHide);
const beating = setInterval(beat, BEAT_MS);

mod.onDispose(() => {
  alive = false;
  clearInterval(beating);
  clearTimeout(pendingLeave?.timer);
  window.removeEventListener('storage', onStorage);
  window.removeEventListener('pagehide', onPageHide);
  proto.send = originals.send;
  for (const name of ['onopen', 'onmessage', 'onclose']) {
    if (originals[name]) Object.defineProperty(proto, name, originals[name]);
  }
});

reconcile(null);                                    // only to learn who the person is, if the panel has said
showCount(read());
mod.live('room', '不在房间里');
