// Room history, the page half: the list in the plugin's settings dialog. The history itself is written by
// main.js into localStorage (STORE), which every window shares; this reads it, and draws again when the main
// window has written to it (the `storage` event is what another window's write looks like). The one thing it
// writes there itself is 清空, which empties it.
//
// It also does what only this window can: the app's panel holds the list of who is in the room it is in (the 联机
// page is drawn from it), with their ids, the room number and the person's own id. A copy goes into localStorage
// under MEMBERS_KEY, for main.js, which writes the history: when the plugin starts in the middle of a room, this
// is how the ones already in it are known. It is read from the page's own data, not asked of the server.
//
// The records are one line per thing that happened. What a person wants is by room: so they are gathered
// into visits, a visit being the time between coming into a room and leaving it. One row for each, the
// newest first: the room number, when, how many people, how long; with 复制 for the number and 展开 for what
// happened in it, which is one row per record, with how long the person stayed on the one that left.

const STORE = 'modkit-room-history';
const MEMBERS_KEY = 'modkit-room-history-members';
const POLL_MS = 2000;              // how often the panel's list is looked at
const REFRESH_MS = 10_000;         // and written again even if it has not changed: main.js does not believe an old copy
const VISITS = 30;                 // rooms in the dialog; the records of the rest are kept, and counted on the first row

const TEXT = {
  here: entry => `${entry.name || '玩家'} 已在房间里${entry.owner ? '（房主）' : ''}${entry.offline ? '（离线）' : ''}`,
  join: entry => `${entry.name || '玩家'} 进入了房间`,
  leave: entry => `${entry.name || '玩家'} 离开了房间`,
  offline: entry => `${entry.name || '玩家'} 掉线了`,
  online: entry => `${entry.name || '玩家'} 重新上线`,
  dismiss: () => '房间已解散',
};

const two = n => String(n).padStart(2, '0');
function dayText(d) {
  return `${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
function clockText(d) {
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
function timeText(t) {
  const d = new Date(t);
  return `${dayText(d)} ${clockText(d)}`;
}
// The end of a visit: only the time of day when it is the day it began.
function endText(start, end) {
  const a = new Date(start);
  const b = new Date(end);
  return dayText(a) === dayText(b) ? clockText(b) : timeText(end);
}
function lengthText(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${Math.floor(minutes / 60)} 小时`;
}

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// The records, oldest first, as visits. A visit begins with 'me-in' and ends with 'me-out' or when the room is
// closed; records of a room that has no beginning on record (the app was already in it when this started, or
// the history was cut) make a visit of their own, which says so and has no length.
// Each record that says somebody left or went offline is given `stayed`: how long since they were first seen,
// and `atLeast` when they were already there then, so that it is a longer time than it says.
function visitsOf(list) {
  const visits = [];
  const open = new Map();                                      // room -> its visit that has not ended
  const ended = new Set();                                     // rooms whose latest visit has ended
  const begin = (entry, known) => {
    const visit = { room: entry.room, start: entry.t, end: null, known, dismissed: false, events: [], first: new Map(), people: new Set() };
    visits.push(visit);
    open.set(entry.room, visit);
    ended.delete(entry.room);
    return visit;
  };

  for (const entry of list) {
    if (!entry || typeof entry.room !== 'string') continue;
    if (entry.type === 'me-in') {
      begin(entry, true);
      continue;
    }
    if (entry.type === 'me-out' && !open.has(entry.room) && ended.has(entry.room)) continue;   // left twice: a room that was closed, or whose leaving was written again
    const visit = open.get(entry.room) ?? begin(entry, false);
    if (entry.type === 'me-out') {
      visit.end = entry.t;
      open.delete(entry.room);
      ended.add(entry.room);
      continue;
    }

    const event = { ...entry };
    if (entry.type === 'here' || entry.type === 'join') {
      visit.people.add(entry.id);
      if (!visit.first.has(entry.id)) visit.first.set(entry.id, { t: entry.t, atLeast: entry.type === 'here' });
    } else if (entry.type === 'leave' || entry.type === 'offline') {
      const first = visit.first.get(entry.id);
      if (first) {
        event.stayed = entry.t - first.t;
        event.atLeast = first.atLeast;
      }
    }
    visit.events.push(event);
    if (entry.type === 'dismiss') {
      visit.end = entry.t;
      visit.dismissed = true;
      open.delete(entry.room);
      ended.add(entry.room);
    }
  }
  return visits.sort((a, b) => b.start - a.start);
}

function currentRoom() {
  const room = window.modkit?.live?.get?.('room-history')?.get?.('room');
  return room && room !== '不在房间里' ? room : null;
}

const button = (label, onClick) => {
  const node = document.createElement('button');
  node.className = 'setting-btn';
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
};

let removers = [];
let timer = null;
const chosen = new Map();          // a visit -> whether the person opened (true) or closed (false) it; otherwise only the newest is open
const keyOf = visit => `${visit.room}@${visit.start}`;

function copyRoom(visit, node) {
  navigator.clipboard.writeText(visit.room).then(() => {
    node.textContent = '已复制';
    setTimeout(() => { node.textContent = '复制'; }, 1500);
  }, () => {
    node.textContent = '复制失败';
    setTimeout(() => { node.textContent = '复制'; }, 1500);
  });
}

function visitRow(visit, isOpen, here) {
  const parts = [];
  if (visit.known) parts.push(visit.end ? `${timeText(visit.start)} 到 ${endText(visit.start, visit.end)}` : timeText(visit.start));
  else parts.push(`${timeText(visit.start)} 起有记录`);
  if (visit.people.size) parts.push(`${visit.people.size} 人`);
  if (visit.known && visit.end) parts.push(`待了 ${lengthText(visit.end - visit.start)}`);
  if (visit.dismissed) parts.push('房间被解散');
  else if (!visit.end) parts.push(visit.room === here ? '还在这个房间里' : '没有记录到离开');

  return {
    title: `房间号 ${visit.room}`,
    description: parts.join(' · '),
    render: () => {
      const copy = button('复制', () => copyRoom(visit, copy));
      const controls = [copy];
      if (visit.events.length) {
        controls.push(button(isOpen ? '收起' : '展开', () => {
          chosen.set(keyOf(visit), !isOpen);
          draw();
        }));
      }
      return controls;
    },
  };
}

function eventRow(event) {
  let description = '';
  if (event.stayed != null) description = `${event.atLeast ? '至少待了' : '待了'} ${lengthText(event.stayed)}${event.atLeast ? '（进房前就已在房间里）' : ''}`;
  return {
    title: `　${(TEXT[event.type] ?? (() => event.type))(event)}`,        // set in a little, under its room
    description,
    value: timeText(event.t),
  };
}

// (Each row added or taken away says the page has changed; the MOD page draws once for all of them.)
function draw() {
  removers.forEach(remove => remove());
  removers = [];
  const all = read();
  const visits = visitsOf(all);
  const here = currentRoom();
  const add = def => removers.push(mod.entry(def));

  add({
    title: '清空记录',
    description: `共 ${all.length} 条记录，${visits.length} 个房间${visits.length > VISITS ? `，这里显示最近 ${VISITS} 个` : ''}`,
    button: {
      label: '清空',
      disabled: !all.length,
      onClick: () => {
        localStorage.removeItem(STORE);
        chosen.clear();
        draw();
      },
    },
  });

  if (!visits.length) add({ title: '还没有记录', description: '进入房间后，这里会按房间整理出来', value: '' });

  visits.slice(0, VISITS).forEach((visit, index) => {
    const isOpen = chosen.has(keyOf(visit)) ? chosen.get(keyOf(visit)) : index === 0;
    add(visitRow(visit, isOpen, here));
    if (isOpen) [...visit.events].reverse().forEach(event => add(eventRow(event)));
  });
  window.modkit.changed();
  renderSection();
}

// --- the 联机 page ------------------------------------------------------------------------------------------------
// The same list, on the app's own page for rooms (the component MainPanelRoomTab), under the members: it is drawn from
// the app's own classes (room-info, room-members, ...), so that it looks like part of the page. Only with a loader
// that has `mod.page` (modkit API 4). Pressing 进入 does what typing the number and pressing the page's own 加入房间 does.

let sectionNode = null;
let sectionStop = null;
let sectionStyle = null;

const SECTION_CSS = `
/* The page is a column, and the list takes what is left of its height, so that it is the list that scrolls and not the page. */
.room-module .panel-content { display: flex; flex-direction: column; }
.room-module .panel-content > :not(.wrh-section) { flex: 0 0 auto; }
.wrh-section { flex: 1 1 0; min-height: 190px; display: flex; flex-direction: column; margin-top: 22px; padding-bottom: 22px; }
.wrh-section .room-info { flex: 0 0 auto; }
.wrh-section .room-members { flex: 1 1 0; min-height: 0; margin-top: 14px; overflow-y: auto; padding-right: 4px; }
.wrh-section .room-members li { height: auto; min-height: 36px; padding: 5px 20px; gap: 12px; flex-wrap: wrap; }
.wrh-section .room-members .room-member-name { width: 200px; }
.wrh-info { flex: 1; min-width: 160px; font-size: 15px; color: rgb(142, 123, 106); }
.wrh-event { background: transparent !important; min-height: 28px !important; padding-left: 44px !important; }
.wrh-event .room-member-name { width: 300px; font-size: 16px !important; white-space: nowrap; }
.wrh-event .wrh-info { flex: 1; min-width: 0; }
.wrh-event .wrh-info:last-child { flex: 0 0 150px; text-align: right; }
.wrh-btn { border: 1px solid rgb(231, 183, 124); background: rgb(254, 210, 145); color: rgb(142, 94, 67); border-radius: 14px; height: 26px; padding: 0 12px; font: inherit; font-size: 15px; cursor: pointer; }
.wrh-btn:disabled { opacity: .5; cursor: default; }
.wrh-empty { font-size: 16px; color: rgb(142, 123, 106); }
`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function smallButton(label, onClick) {
  const node = el('button', 'wrh-btn', label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

// What the person pressed 进入 for: the number goes into the page's room box, and the page's own join does the rest.
async function enterRoom(visit, node) {
  node.disabled = true;
  try {
    await mod.app.action('set-room-id-input', { value: visit.room });
    await new Promise(resolve => setTimeout(resolve, 150));
    await mod.app.action('join-room');
    node.textContent = '已发出';
  } catch {
    node.textContent = '没能进入';
  }
  setTimeout(() => {
    node.textContent = '进入';
    node.disabled = false;
  }, 2000);
}

function sectionRows(visits, here) {
  const list = el('ul', 'room-members common-scrollbar2');      // the app's own scrollbar
  if (!visits.length) {
    const row = el('li');
    row.append(el('span', 'wrh-empty', '还没有记录，进入房间后会按房间整理在这里'));
    list.append(row);
    return list;
  }
  visits.slice(0, VISITS).forEach((visit, index) => {
    const isOpen = chosen.has(keyOf(visit)) ? chosen.get(keyOf(visit)) : false;
    const row = el('li');
    row.append(el('span', 'room-member-name', `房间号 ${visit.room}`));
    row.append(el('span', 'wrh-info', visitRow(visit, isOpen, here).description));
    if (!here && visit.room) {
      const enter = smallButton('进入', () => enterRoom(visit, enter));
      row.append(enter);
    }
    const copy = smallButton('复制', () => copyRoom(visit, copy));
    row.append(copy);
    if (visit.events.length) {
      row.append(smallButton(isOpen ? '收起' : '展开', () => {
        chosen.set(keyOf(visit), !isOpen);
        draw();
      }));
    }
    list.append(row);
    if (isOpen) {
      for (const event of [...visit.events].reverse()) {
        const detail = eventRow(event);
        const sub = el('li', 'wrh-event');
        sub.append(el('span', 'room-member-name', detail.title.trim()));
        sub.append(el('span', 'wrh-info', detail.description));
        sub.append(el('span', 'wrh-info', detail.value));
        list.append(sub);
      }
    }
  });
  return list;
}

function renderSection() {
  if (!sectionNode) return;
  const all = read();
  const visits = visitsOf(all);
  const header = el('div', 'room-info');
  header.append(el('div', 'room-qty', '房间历史'));
  header.append(el('div', 'room-number', `共 ${visits.length} 个房间，${all.length} 条记录`));
  sectionNode.replaceChildren(header, sectionRows(visits, currentRoom()));
}

function startSection() {
  if (!mod.page) return;
  sectionStyle = mod.css(SECTION_CSS);
  sectionNode = el('div', 'wrh-section');
  sectionStop = mod.page.onComponent('MainPanelRoomTab', () => {
    renderSection();
    return mod.page.mount('.room-module .panel-content', sectionNode);
  });
}

function stopSection() {
  sectionStop?.();
  sectionStyle?.();
  sectionNode?.remove();
  sectionNode = null;
}

// Writes come in bursts (a room full of people arriving): one drawing for all of them.
function soon() {
  clearTimeout(timer);
  timer = setTimeout(draw, 150);
}

// The component of the panel that has the room's props (MainModulePanel: roomMembers, currentRoomId,
// localMemberId, ...), found by walking the page's components, and kept until it is gone.
let roomView = null;
function findRoomView() {
  const app = document.querySelector('#app')?.__vue_app__;
  const seen = new Set();
  const walk = (vnode, depth) => {
    if (!vnode || typeof vnode !== 'object' || depth > 80) return null;
    const component = vnode.component;
    if (component && !seen.has(component)) {
      seen.add(component);
      if (component.props && 'roomMembers' in component.props && 'currentRoomId' in component.props) return component;
      const inner = walk(component.subTree, depth + 1);
      if (inner) return inner;
    }
    if (Array.isArray(vnode.children)) {
      for (const child of vnode.children) {
        const found = walk(child, depth + 1);
        if (found) return found;
      }
    }
    return vnode.suspense ? walk(vnode.suspense.activeBranch, depth + 1) : null;
  };
  return walk(app?._instance?.vnode ?? app?._container?._vnode, 0);
}

function membersNow(view) {
  const props = view.props;
  const list = Array.isArray(props.roomMembers) ? props.roomMembers : [];
  return {
    room: typeof props.currentRoomId === 'string' ? props.currentRoomId.trim() : '',
    self: Number(props.localMemberId) > 0 ? Number(props.localMemberId) : 0,
    members: list
      .filter(member => member && Number(member.id) > 0)
      .map(member => ({ id: Number(member.id), name: typeof member.nickname === 'string' ? member.nickname : '', owner: member.isOwner === true, online: member.online !== false })),
  };
}

let publishedText = '';
let publishedAt = 0;
let publishing = false;

// What was copied while the panel was open is marked old when it is closed, so that main.js does not take it
// for the room as it is now. Who the person is stays: that does not go out of date.
function markOld() {
  try {
    const copy = JSON.parse(localStorage.getItem(MEMBERS_KEY));
    if (copy) localStorage.setItem(MEMBERS_KEY, JSON.stringify({ ...copy, members: [], t: 0 }));
  } catch {
    // nothing was copied, or it is not readable: nothing to mark
  }
}

async function publish() {
  if (publishing) return;
  publishing = true;
  try {
    if (!roomView || roomView.isUnmounted) roomView = findRoomView();
    if (!roomView) return;

    // The app only sends the room to the panel while the panel is open. Closed, what the panel holds is the room as
    // it was when it was closed, and copying it again and again would make it look current.
    let open = true;
    try {
      open = (await mod.invoke('plugin:window|is_visible', { label: 'panel' })) !== false;
    } catch {
      // the window cannot be asked: taken as open, as it was before this was asked
    }
    if (!open) {
      if (publishedAt) {
        publishedAt = 0;
        publishedText = '';
        markOld();
      }
      return;
    }

    const text = JSON.stringify(membersNow(roomView));
    const now = Date.now();
    if (text === publishedText && now - publishedAt < REFRESH_MS) return;
    publishedText = text;
    publishedAt = now;
    localStorage.setItem(MEMBERS_KEY, JSON.stringify({ ...JSON.parse(text), t: now }));
  } catch (err) {
    roomView = null;                                           // look again next time
  } finally {
    publishing = false;
  }
}

const onStorage = event => {
  if (event.key === STORE || event.key === null) soon();
};
window.addEventListener('storage', onStorage);

const watching = setInterval(publish, POLL_MS);

mod.onDispose(() => {
  clearInterval(watching);
  localStorage.removeItem(MEMBERS_KEY);
  clearTimeout(timer);
  window.removeEventListener('storage', onStorage);
  removers.forEach(remove => remove());
  removers = [];
  stopSection();
});

publish();
startSection();
draw();
