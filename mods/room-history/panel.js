// Room history, the page half: the list in the plugin's settings dialog. The history itself is written by
// main.js into localStorage (STORE), which every window shares; this only reads it, and draws again when
// the main window has written to it (the `storage` event is what another window's write looks like).
//
// One row per record, the newest first, in the app's own rows: what happened, in the title; the room number
// under it; the time on the right.

const STORE = 'modkit-room-history';
const SHOWN = 60;                  // rows in the dialog; the rest are kept, and counted on the first row

const TEXT = {
  'me-in': () => '我进入了房间',
  'me-out': () => '我离开了房间',
  here: entry => `${entry.name || '玩家'} 已在房间里`,
  join: entry => `${entry.name || '玩家'} 进入了房间`,
  leave: entry => `${entry.name || '玩家'} 离开了房间`,
  offline: entry => `${entry.name || '玩家'} 掉线了`,
  online: entry => `${entry.name || '玩家'} 重新上线`,
  dismiss: () => '房间已解散',
};

const two = n => String(n).padStart(2, '0');
function timeText(t) {
  const d = new Date(t);
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

let removers = [];
let timer = null;

function draw() {
  removers.forEach(remove => remove());
  removers = [];
  const all = read();

  removers.push(mod.entry({
    title: '清空记录',
    description: all.length > SHOWN ? `共 ${all.length} 条，这里显示最近 ${SHOWN} 条` : `共 ${all.length} 条`,
    button: {
      label: '清空',
      disabled: !all.length,
      onClick: () => {
        localStorage.removeItem(STORE);
        draw();
      },
    },
  }));

  if (!all.length) {
    removers.push(mod.entry({ title: '还没有记录', description: '有人进入或离开房间时，这里会出现', value: '' }));
  }
  for (const entry of all.slice(-SHOWN).reverse()) {
    removers.push(mod.entry({
      title: (TEXT[entry.type] ?? (() => entry.type))(entry),
      description: entry.room ? `房间号 ${entry.room}` : '',
      value: timeText(entry.t),
    }));
  }
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
