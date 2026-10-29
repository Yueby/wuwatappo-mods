// Room history, the page half: the list in the plugin's settings dialog. The history itself is written by
// main.js into localStorage (STORE), which every window shares; this only reads it, and draws again when
// the main window has written to it (the `storage` event is what another window's write looks like).
//
// The records are one line per thing that happened. What a person wants is by room: so they are gathered
// into visits, a visit being the time between coming into a room and leaving it. One row for each, the
// newest first: the room number, when, how many people, how long; with 复制 for the number and 展开 for what
// happened in it, which is one row per record, with how long the person stayed on the one that left.

const STORE = 'modkit-room-history';
const VISITS = 30;                 // rooms in the dialog; the records of the rest are kept, and counted on the first row

const TEXT = {
  here: entry => `${entry.name || '玩家'} 已在房间里`,
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
  const begin = (entry, known) => {
    const visit = { room: entry.room, start: entry.t, end: null, known, dismissed: false, events: [], first: new Map(), people: new Set() };
    visits.push(visit);
    open.set(entry.room, visit);
    return visit;
  };

  for (const entry of list) {
    if (!entry || typeof entry.room !== 'string') continue;
    if (entry.type === 'me-in') {
      begin(entry, true);
      continue;
    }
    const visit = open.get(entry.room) ?? begin(entry, false);
    if (entry.type === 'me-out') {
      visit.end = entry.t;
      open.delete(entry.room);
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
  if (event.stayed != null) description = `${event.atLeast ? '至少待了' : '待了'} ${lengthText(event.stayed)}${event.atLeast ? '（我进房时他已经在）' : ''}`;
  return {
    title: `　${(TEXT[event.type] ?? (() => event.type))(event)}`,        // set in a little, under its room
    description,
    value: timeText(event.t),
  };
}

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
}

// Writes come in bursts (a room full of people arriving): one drawing for all of them.
function soon() {
  clearTimeout(timer);
  timer = setTimeout(draw, 150);
}

const onStorage = event => {
  if (event.key === STORE || event.key === null) soon();
};
window.addEventListener('storage', onStorage);

mod.onDispose(() => {
  clearTimeout(timer);
  window.removeEventListener('storage', onStorage);
  removers.forEach(remove => remove());
  removers = [];
});

draw();
