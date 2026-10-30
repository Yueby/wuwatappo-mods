// mods/pet-position, run against a stand-in for the app: pets (the person's own and other players') dragged by `mouse-move` / `mouse-button`
// events as the native hook sends them (it takes the press first: moves that come too soon are ignored), that is
// kept inside what is free, that saves its place 40 ms after a drag, and that can be pushed by "the room" with a
// save of its own. Nothing here touches the real app.
//
//   node --test tests/pet-position.test.js

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const folder = path.join(import.meta.dirname, '..', 'mods', 'pet-position');
const original = await fs.readFile(path.join(folder, 'main.js'), 'utf8');
const panelSource = await fs.readFile(path.join(folder, 'panel.js'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const running = [];
after(() => running.forEach(run => run.dispose()));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (check()) return true;
    await sleep(5);
  }
  return false;
}
const PLACEMENT_KEY = 'wuwatappo-main-pet-placement-v1';
const SETTINGS_KEY = 'wuwatappo-settings';
const STORE = 'modkit-pet-position';
const NOW_KEY = 'modkit-pet-position-now';

// The waits are seconds long; a test cannot wait that. Each constant is replaced, and each has to have been found.
const FAST = {
  CHECK_MS: 20, STARTUP_WAIT_MS: 0, QUIET_MS: 120, MOVE_QUIET_MS: 80, SENT_MS: 300, SETTLE_MS: 90, ACCEPT_MS: 150, SETTINGS_ACCEPT_MS: 300,
  GEOMETRY_MS: 10_000, NOTICE_MS: 400, GRAB_WAIT_MS: 4, PRESS_WAIT_MS: 25, STEP_MS: 3, STEPS: 5, RELEASE_WAIT_MS: 4, VERIFY_MS: 40, ECHO_MS: 30, TOLERANCE_PX: 2,
};
function fastSource(extra = {}) {
  let source = original;
  const { RETRIES, ...constants } = extra;
  for (const [name, value] of Object.entries({ ...FAST, ...constants })) {
    const pattern = new RegExp(`const ${name} = [\\d_]+;`);
    assert.match(source, pattern, `${name} is in the mod`);
    source = source.replace(pattern, `const ${name} = ${value};`);
  }
  const retries = /const RETRY_MS = \[[^\]]*\];/;
  assert.match(source, retries, 'RETRY_MS is in the mod');
  return source.replace(retries, `const RETRY_MS = [${(RETRIES ?? [60, 120, 240, 480]).join(', ')}];`);
}

// The page's storage, with a prototype that can be wrapped, as the browser's is.
class FakeStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

const FRIEND = { dx: 25, dy: 53, w: 150, h: 158 };       // another player's pet: its body from its style's left and top
const CONTENT = { dx: 49, dy: 173, w: 150, h: 158 };       // the pet's body, from the dock's left and top (as measured on the real page)
const placementOf = dock => JSON.stringify({ at: [dock.left, dock.top] });

function makeApp(localStorage, options = {}) {
  const app = {
    dock: { left: 2325, top: 1061 },
    bounds: { minLeft: 0, maxLeft: 2325, minTop: 0, maxTop: 1061 },     // what is free: the dock is kept inside
    vw: 2560, vh: 1440, scale: 0.75,
    armDelay: options.armDelay ?? 10,                                    // how long after a press the app takes moves
    saveDelay: 40,
    pointer: { x: 0, y: 0 },
    drag: null,
    friends: new Map(),                                                  // id -> { left, top }: other players' pets
    covered: false,
    hidden: false,
    friendDrags: 0,
    picked: [],                                                          // what each press picked up, in order
    emitted: [],
    saves: 0,
    clamp(dock) {
      return { left: Math.min(this.bounds.maxLeft, Math.max(this.bounds.minLeft, dock.left)), top: Math.min(this.bounds.maxTop, Math.max(this.bounds.minTop, dock.top)) };
    },
    content() { return { left: this.dock.left + CONTENT.dx, top: this.dock.top + CONTENT.dy, width: CONTENT.w, height: CONTENT.h }; },
    inside(x, y) { const c = this.content(); return x >= c.left && x <= c.left + c.width && y >= c.top && y <= c.top + c.height; },
    friendRect(f) { return { left: f.left + FRIEND.dx, top: f.top + FRIEND.dy, width: FRIEND.w, height: FRIEND.h }; },
    // the player whose pet is at the point (the one that came last is on top), if any
    friendAt(x, y) {
      for (const [id, f] of [...this.friends].reverse()) {
        const r = this.friendRect(f);
        if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) return id;
      }
      return null;
    },
    // a player comes in: the app puts the pet in a slot
    join(id, left, top) { this.friends.set(String(id), { left, top, positioned: true }); },
    // the app puts a player's pet somewhere (a slot again, after the person entered a room)
    place(id, left, top) { Object.assign(this.friends.get(String(id)), { left, top }); },
    clampFriend(left, top) { return { left: Math.min(2400, Math.max(0, left)), top: Math.min(1280, Math.max(0, top)) }; },
    save() { this.saves += 1; localStorage.setItem(PLACEMENT_KEY, placementOf(this.dock)); },
    // What the native hook sends, as the app takes it.
    handle(event, payload) {
      if (event === 'mouse-move') {
        this.pointer = { x: payload.x, y: payload.y };
        if (this.drag && Date.now() >= this.drag.armedAt) {
          const to = { left: this.drag.from.left + payload.x - this.drag.at.x, top: this.drag.from.top + payload.y - this.drag.at.y };
          if (this.drag.friend) Object.assign(this.friends.get(this.drag.friend), this.clampFriend(to.left, to.top));
          else this.dock = this.clamp(to);
        }
      } else if (event === 'mouse-button' && payload.button === 'left') {
        if (payload.action === 'press') {
          const friend = this.friendAt(this.pointer.x, this.pointer.y);
          this.picked.push(friend ?? (this.inside(this.pointer.x, this.pointer.y) ? 'me' : null));
          if (friend !== null) this.drag = { friend, from: { ...this.friends.get(friend) }, at: { ...this.pointer }, armedAt: Date.now() + this.armDelay };
          else if (this.inside(this.pointer.x, this.pointer.y)) this.drag = { from: { ...this.dock }, at: { ...this.pointer }, armedAt: Date.now() + this.armDelay };
        }
        if (payload.action === 'release' && this.drag) {
          const now = this.drag.friend ? this.friends.get(this.drag.friend) : this.dock;
          const moved = this.drag.from.left !== now.left || this.drag.from.top !== now.top;
          const friend = this.drag.friend;
          this.drag = null;
          if (friend) this.friendDrags += 1;                       // a player's pet: nothing is saved, and nothing is sent to the room
          else if (moved) setTimeout(() => this.save(), this.saveDelay);
        }
      }
    },
    // The room (or the taskbar) pushes the pet, and the app saves where it ended up.
    push(dx, dy, { save = true } = {}) {
      this.dock = this.clamp({ left: this.dock.left + dx, top: this.dock.top + dy });
      if (save) this.save();
    },
  };
  return app;
}

function load({ storage = new FakeStorage(), config = {}, extra = {}, appOptions = {}, prepare = null, started = true } = {}) {
  const Storage = FakeStorage;
  const localStorage = storage;
  Storage.prototype.setItem = FakeStorage.prototype.setItem;               // each run starts from the plain one
  const app = makeApp(localStorage, appOptions);
  prepare?.(app, localStorage);
  const settings = { restore: true, ...config };
  const live = {};
  const logs = [];
  const warnings = [];
  const disposers = [];
  const handlers = new Map();
  const listeners = new Map();
  const userEvents = [];

  const mod = {
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => warnings.push(a.join(' ')),
    live: (key, value) => { live[key] = value; },
    onDispose: fn => disposers.push(fn),
    config: { get: key => settings[key] },
    onEvent: (name, fn) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    invoke: async (command, args) => {
      if (command === 'plugin:window|inner_position') return { x: 0, y: 0 };
      if (command === 'plugin:window|scale_factor') return 1;
      if (command === 'plugin:event|emit') {
        if (run.failEmitAt !== null && app.emitted.length + 1 === run.failEmitAt) { app.emitted.push({ event: args.event, failed: true }); throw new Error('emit failed'); }
        app.emitted.push({ event: args.event, payload: args.payload, at: Date.now() });
        app.handle(args.event, args.payload);
        setTimeout(() => (handlers.get(args.event) ?? []).forEach(fn => fn({ event: args.event, id: 0, payload: args.payload })), 5);   // it hears its own events, a moment later
        return null;
      }
      throw new Error(`unexpected command ${command}`);
    },
  };
  const friendElement = (id, f) => ({
    dataset: { roomCatId: id, ...(f.positioned === false ? {} : { roomCatPositioned: 'true' }) },
    getAttribute: () => `left: ${f.left}px; top: ${f.top}px; --x: 1;`,
    getBoundingClientRect: () => app.friendRect(f),
  });
  const document = {
    documentElement: {},
    querySelector: selector => {
      if (app.hidden) return null;
      if (selector === '.pet-dock') return { getAttribute: () => `inset: ${app.dock.top}px auto auto ${app.dock.left}px;` };
      if (selector === '.pet-dock-content') return { getBoundingClientRect: () => app.content() };
      return null;
    },
    querySelectorAll: selector => {
      if (selector !== '[data-room-cat-id]') return [];
      return [...app.friends].map(([id, f]) => friendElement(id, f));
    },
    elementFromPoint: (x, y) => {
      if (app.covered) return { closest: () => null };
      const friend = app.friendAt(x, y);
      if (friend !== null) return { closest: selector => (selector === '[data-room-cat-id]' ? friendElement(friend, app.friends.get(friend)) : null) };
      return app.inside(x, y) ? { closest: selector => (selector === '.pet-dock-content' ? {} : null) } : { closest: () => null };
    },
  };
  const window = {
    get innerWidth() { return app.vw; },
    get innerHeight() { return app.vh; },
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter(f => f !== fn)),
  };
  const getComputedStyle = () => ({ getPropertyValue: () => String(app.scale) });

  // the person: the native hook tells the app and the plugin alike
  const person = {
    async drag(dx, dy, who = 'me') {
      const c = who === 'me' ? app.content() : app.friendRect(app.friends.get(String(who)));
      const start = { x: c.left + c.width / 2, y: c.top + c.height / 2 };
      const send = (event, payload) => { userEvents.push(event); app.handle(event, payload); (handlers.get(event) ?? []).forEach(fn => fn({ event, id: 0, payload })); };
      send('mouse-move', start);
      send('mouse-button', { button: 'left', action: 'press' });
      await sleep(app.armDelay + 5);
      for (let i = 1; i <= 4; i += 1) { send('mouse-move', { x: start.x + (dx * i) / 4, y: start.y + (dy * i) / 4 }); await sleep(3); }
      send('mouse-button', { button: 'left', action: 'release' });
    },
    // a mouse moving somewhere (not the pet's doing, and not the plugin's): the hook tells the app and the plugin
    wiggle(x = 10, y = 10) { (handlers.get('mouse-move') ?? []).forEach(fn => fn({ event: 'mouse-move', id: 0, payload: { x, y } })); },
    press() { const c = app.content(); (handlers.get('mouse-button') ?? []).forEach(fn => fn({ payload: { button: 'left', action: 'press' } })); void c; },
    release() { (handlers.get('mouse-button') ?? []).forEach(fn => fn({ payload: { button: 'left', action: 'release' } })); },
  };

  const run = { app, storage: localStorage, settings, live, logs, warnings, listeners, handlers, person, userEvents, failEmitAt: null,
    emitted: () => app.emitted.map(e => e.event + (e.payload?.action ? `:${e.payload.action}` : '')),
    stored: () => JSON.parse(localStorage.getItem(STORE) ?? 'null'),
    dispose: () => disposers.forEach(fn => fn()) };
  if (started) {
    new AsyncFunction('mod', 'document', 'window', 'localStorage', 'Storage', 'getComputedStyle', fastSource(extra))(mod, document, window, localStorage, Storage, getComputedStyle);
  }
  running.push(run);
  return run;
}

const at = (run, left, top) => assert.deepEqual(run.app.dock, { left, top });

test('what it declares and shows: no permission, a switch for the moving back, and no person words', () => {
  assert.equal(manifest.modkit.permissions, undefined);
  assert.equal(manifest.modkit.defaultEnabled, undefined, 'it is on: it only moves the pet');
  assert.deepEqual(manifest.modkit.settings.map(s => s.key), ['restore', 'others', 'remembered', 'state']);
  const code = (original + panelSource).split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  const strings = [...code.matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)].map(m => m[1] ?? m[2]).filter(text => /[一-鿿]/.test(text));
  for (const text of [manifest.description, manifest.displayName, ...manifest.modkit.settings.flatMap(s => [s.title, s.description, typeof s.default === 'string' ? s.default : null]), ...strings].filter(Boolean)) {
    assert.ok(!/[我咱您你她]|(?<!其)他/.test(text), `a person word in "${text}"`);
  }
  assert.ok(!/fetch\(|XMLHttpRequest|new WebSocket/.test(code), 'it sends nothing anywhere');
});

test('the waits it really has are pinned here: what the tests shorten', () => {
  for (const line of ['const CHECK_MS = 2000;', 'const STARTUP_WAIT_MS = 6000;', 'const QUIET_MS = 8000;', 'const SETTLE_MS = 1200;', 'const ACCEPT_MS = 2500;', 'const TOLERANCE_PX = 2;', 'const PRESS_WAIT_MS = 150;', 'const MOVE_QUIET_MS = 1500;', 'const NOTICE_MS = 10_000;', 'const STEP_MS = 40;', 'const STEPS = 10;', 'const GRAB_WAIT_MS = 120;', 'const VERIFY_MS = 1000;', 'const RETRY_MS = [5000, 15000, 60000, 300000];']) {
    assert.ok(original.includes(line), `${line} is the real value`);
  }
});

test('started with nothing remembered, it takes the place the pet is at, and says so', async () => {
  const run = load();
  await sleep(60);
  const stored = run.stored();
  assert.equal(stored.v, 2);
  assert.deepEqual(stored.layout, { vw: 2560, vh: 1440, scale: 0.75 });
  assert.equal(stored.placement, null);
  assert.deepEqual(Object.keys(stored.pets), ['me'], 'the places of the others are not taken until the person drags them');
  assert.deepEqual([stored.pets.me.left, stored.pets.me.top], [2325, 1061]);
  assert.equal(run.live.remembered, '左 2325，上 1061');
  assert.equal(run.live.state, '桌宠在记住的位置');
  assert.deepEqual(run.emitted(), [], 'nothing is moved');
});

test('a drag by the person is remembered, and the app\'s saving of it is let through', async () => {
  const run = load();
  await sleep(40);
  await run.person.drag(-300, -200);
  await sleep(250);                                          // the app saves 40 ms after the release; remembered after the settle time
  at(run, 2025, 861);
  assert.deepEqual([run.stored().pets.me.left, run.stored().pets.me.top], [2025, 861]);
  assert.equal(run.storage.getItem(PLACEMENT_KEY), placementOf({ left: 2025, top: 861 }), 'the app\'s own saving went through');
  assert.equal(run.stored().placement, placementOf({ left: 2025, top: 861 }), 'and what it saved is kept with the place');
  assert.equal(run.live.remembered, '左 2025，上 861');
  assert.deepEqual(run.emitted(), [], 'the person\'s own drag is not "fixed"');
});

test('a click on the pet, with no move, is not a new place', async () => {
  const run = load();
  await sleep(40);
  const before = run.stored();
  await run.person.drag(0, 0);
  await sleep(250);
  assert.deepEqual(run.stored(), before);
});

test('the app saving a place on its own is not let through: what it keeps is the person\'s', async () => {
  const run = load();
  await sleep(40);
  await run.person.drag(-300, -200);
  await sleep(300);
  const kept = run.storage.getItem(PLACEMENT_KEY);
  run.app.bounds.maxLeft = 2000;                              // the room takes the right side
  run.app.push(0, 0, { save: true });                         // and the app pushes the pet and saves where it is
  assert.equal(run.storage.getItem(PLACEMENT_KEY), kept, 'the saved place did not change');
  assert.equal(run.app.saves, 2, 'the app did try to save twice');
  assert.match(run.logs.join('\n'), /已挡下/, 'said once in the log');
  run.app.push(0, 0, { save: true });
  assert.equal(run.logs.filter(l => /已挡下/.test(l)).length, 1, 'once, not every time');
});

test('pushed away by something, the pet is dragged back to where the person left it: the same events the hook sends', async () => {
  const run = load();
  await sleep(40);
  await run.person.drag(-300, -200);
  await sleep(300);
  const placed = { ...run.app.dock };
  run.app.bounds.maxLeft = 1900;                              // the room takes the right side: the pet is pushed
  run.app.push(0, 0);
  assert.ok(run.app.dock.left < placed.left, 'it was pushed');
  run.app.bounds.maxLeft = 2325;                              // and the room is left: there is room again
  assert.ok(await until(() => run.live.state === '已拖回记住的位置'), 'it says it was brought back');
  await sleep(120);                                           // a few looks later, still within the time it keeps saying so
  assert.equal(run.live.state, '已拖回记住的位置', 'and it goes on saying so for a while');
  at(run, placed.left, placed.top);
  const events = run.emitted();
  assert.equal(events[0], 'mouse-move');
  assert.equal(events[1], 'mouse-button:press');
  assert.equal(events.at(-1), 'mouse-button:release');
  assert.ok(events.slice(2, -1).every(e => e === 'mouse-move') && events.length >= 6, 'moves in between');
  assert.equal(run.live.state, '已拖回记住的位置');
  assert.equal(run.storage.getItem(PLACEMENT_KEY), placementOf(placed), 'and the app\'s saving of the way back went through');
  await sleep(550);
  assert.equal(run.live.state, '桌宠在记住的位置', 'and after a while it says the pet is in the place again');
  assert.deepEqual([run.stored().pets.me.left, run.stored().pets.me.top], [placed.left, placed.top], 'what is remembered is the same');
});

test('its own events are not taken for the person\'s: nothing new is remembered after it moved the pet', async () => {
  const run = load();
  await sleep(40);
  run.app.bounds.maxLeft = 2000;
  run.app.push(0, 0);
  run.app.bounds.maxLeft = 2325;
  await sleep(700);
  at(run, 2325, 1061);
  assert.deepEqual([run.stored().pets.me.left, run.stored().pets.me.top], [2325, 1061]);
  await sleep(300);
  assert.equal(run.stored().pets.me.left, 2325);
});

test('while the person is using the mouse it does not move the pet, and waits for a quiet moment', async () => {
  const run = load();
  await sleep(40);
  run.app.bounds.maxLeft = 2000;
  run.app.push(0, 0);
  run.app.bounds.maxLeft = 2325;
  run.person.press();                                         // the button is held
  await sleep(250);
  assert.deepEqual(run.emitted(), [], 'not while a button is held');
  run.person.release();
  await sleep(60);
  assert.deepEqual(run.emitted(), [], 'and not right after');
  await sleep(700);
  at(run, 2325, 1061);
});

test('with the switch off it only keeps the saved place, and says the pet is elsewhere', async () => {
  const run = load({ config: { restore: false } });
  await sleep(40);
  run.app.bounds.maxLeft = 2000;
  run.app.push(0, 0);
  await sleep(300);
  assert.deepEqual(run.emitted(), []);
  assert.equal(run.live.state, '桌宠不在记住的位置（已设为不自动拖回）');
  assert.equal(run.stored().pets.me.left, 2325, 'and what is remembered did not follow the push');
});

test('a place the app will not give back is tried again later and later, not in a loop', async () => {
  const run = load();
  await sleep(40);
  run.app.bounds.maxLeft = 1900;                              // the room is still there: the pet cannot go back
  run.app.push(0, 0);
  await sleep(1300);
  const presses = run.emitted().filter(e => e === 'mouse-button:press').length;
  assert.ok(presses >= 2 && presses <= 4, `a few tries, each after a longer wait: ${presses}`);
  assert.equal(run.live.state, '桌宠没能回到记住的位置（那里可能被占着），稍后再试');
  run.app.bounds.maxLeft = 2325;                              // the room is left
  assert.ok(await until(() => run.live.state === '已拖回记住的位置', 5000), 'it is brought back once there is room');
  at(run, 2325, 1061);
});

test('the button is always let go, even if sending an event fails half way', async () => {
  const run = load();
  run.failEmitAt = 4;                                         // the third move
  await sleep(40);
  run.app.bounds.maxLeft = 2000;
  run.app.push(0, 0);
  run.app.bounds.maxLeft = 2325;
  await sleep(500);
  assert.equal(run.emitted().at(-1) === 'mouse-button:release' || run.emitted().filter(e => e === 'mouse-button:release').length === 1, true, 'a release was sent');
  assert.equal(run.app.drag, null, 'the app is not left holding a drag');
  assert.match(run.warnings.join('\n'), /拖回桌宠没有成功/);
});

test('a pet that is covered, or not there, is not dragged at', async () => {
  const run = load();
  await sleep(40);
  run.app.bounds.maxLeft = 2000;
  run.app.push(0, 0);
  run.app.bounds.maxLeft = 2325;
  run.app.covered = true;
  await sleep(500);
  assert.deepEqual(run.emitted(), []);
  assert.match(run.live.state, /点不到它/);
});

test('when the screen or the pet\'s size is not what it was, the old place is not used', async () => {
  const run = load();
  await sleep(40);
  run.app.bounds.maxLeft = 2000;
  run.app.push(0, 0);
  run.app.vw = 1920;
  run.app.vh = 1080;                                          // another screen
  await sleep(300);
  assert.deepEqual(run.emitted(), []);
  assert.equal(run.live.state, '屏幕或桌宠大小变了，之前记的位置不再用');
});

test('where the pet goes, set in the app\'s settings, is the person\'s choice: the old place is let go and the new one taken', async () => {
  const storage = new FakeStorage();
  storage.setItem(SETTINGS_KEY, JSON.stringify({ position: 'bottomRight', petScale: 75, windowOpacity: 100 }));
  const run = load({ storage });
  await sleep(40);
  run.app.bounds.maxLeft = 2000;
  run.storage.setItem(SETTINGS_KEY, JSON.stringify({ position: 'bottomRight', petScale: 75, windowOpacity: 60 }));     // the opacity: not a place
  assert.ok(run.stored(), 'the place is kept');
  run.storage.setItem(SETTINGS_KEY, JSON.stringify({ position: 'topLeft', petScale: 75, windowOpacity: 60 }));         // the corner
  assert.equal(run.stored(), null, 'the old place is let go');
  run.app.dock = { left: 12, top: 20 };                       // the app moves the pet to the corner and saves it
  run.app.save();
  assert.equal(run.storage.getItem(PLACEMENT_KEY), placementOf({ left: 12, top: 20 }), 'the app\'s saving went through');
  await sleep(450);
  assert.deepEqual([run.stored().pets.me.left, run.stored().pets.me.top], [12, 20], 'the corner is the place now');
  assert.deepEqual(run.emitted(), [], 'and the pet is not dragged back');
});

test('"take the place it is at now", asked by the panel, is done', async () => {
  const run = load();
  await sleep(40);
  run.app.dock = { left: 100, top: 100 };
  for (const fn of run.listeners.get('storage') ?? []) fn({ key: NOW_KEY, newValue: '123' });
  assert.deepEqual([run.stored().pets.me.left, run.stored().pets.me.top], [100, 100]);
  assert.equal(run.live.state, '已把现在的位置记下来');
  for (const fn of run.listeners.get('storage') ?? []) fn({ key: NOW_KEY, newValue: null });          // the panel taking its request away
  assert.equal(run.stored().pets.me.left, 100);
});

test('started while the app has saved another place than the one remembered, the remembered one is put back for the next start', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, JSON.stringify({ left: 2325, top: 1061, vw: 2560, vh: 1440, scale: 0.75, placement: 'the person\'s place' }));
  storage.setItem(PLACEMENT_KEY, 'the pushed place');
  const run = load({ storage });
  await sleep(30);
  assert.equal(run.storage.getItem(PLACEMENT_KEY), 'the person\'s place');

  const other = new FakeStorage();
  other.setItem(STORE, JSON.stringify({ left: 10, top: 10, vw: 1920, vh: 1080, scale: 0.75, placement: 'old screen' }));
  other.setItem(PLACEMENT_KEY, 'this screen');
  const second = load({ storage: other });
  await sleep(30);
  assert.equal(second.storage.getItem(PLACEMENT_KEY), 'this screen', 'not for another screen');
});

test('after a restart, the pet that came up somewhere else is dragged to the remembered place once things are settled', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, JSON.stringify({ left: 2000, top: 900, vw: 2560, vh: 1440, scale: 0.75, placement: placementOf({ left: 2000, top: 900 }) }));
  const run = load({ storage, extra: { STARTUP_WAIT_MS: 150 } });
  await sleep(60);
  assert.deepEqual(run.emitted(), [], 'not at once: the app may still be starting');
  await sleep(800);
  at(run, 2000, 900);
});

test('switched off, WebSocket-like state is given back: the app saves as it did, and nothing is left running', async () => {
  const run = load();
  await sleep(40);
  const wrapped = FakeStorage.prototype.setItem;
  run.dispose();
  assert.notEqual(FakeStorage.prototype.setItem, wrapped, 'the app\'s own function is back');
  run.app.dock = { left: 5, top: 5 };
  run.app.save();
  assert.equal(run.storage.getItem(PLACEMENT_KEY), placementOf({ left: 5, top: 5 }), 'its saving is not held back any more');
  assert.equal((run.listeners.get('storage') ?? []).length, 0);
  run.app.bounds.maxLeft = 1000;
  run.app.push(0, 0, { save: false });
  await sleep(400);
  assert.deepEqual(run.emitted(), [], 'and the pet is not moved');
});

test('the panel half is one button that asks for the place now, and takes its request away when it stops', () => {
  const rows = [];
  const disposers = [];
  const data = new Map();
  const localStorage = { setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
  const mod = { entry: def => { rows.push(def); return () => rows.splice(rows.indexOf(def), 1); }, onDispose: fn => disposers.push(fn) };
  new AsyncFunction('mod', 'localStorage', panelSource)(mod, localStorage);
  assert.equal(rows.length, 1);
  rows[0].button.onClick();
  assert.ok(data.get(NOW_KEY));
  disposers.forEach(fn => fn());
  assert.equal(rows.length, 0);
  assert.equal(data.has(NOW_KEY), false);
});

test('only part of the way back, the place it came to is not taken for the person\'s: what is remembered stays', async () => {
  const storage = new FakeStorage();
  storage.setItem(PLACEMENT_KEY, placementOf({ left: 2325, top: 1061 }));
  const run = load({ storage });
  await sleep(40);
  run.app.bounds.maxLeft = 1900;
  run.app.push(0, 0);                                         // pushed to 1900 by the room
  run.app.bounds.maxLeft = 2100;                              // the room gives half of it back
  await sleep(500);
  assert.equal(run.app.dock.left, 2100, 'it came part of the way');
  assert.equal(run.stored().pets.me.left, 2325, 'and what is remembered did not move with it');
  assert.equal(run.storage.getItem(PLACEMENT_KEY), placementOf({ left: 2325, top: 1061 }), 'nor what the app keeps for its next start');
});

test('the echo of its own events does not hold up the next try: it is the person\'s touch that does', async () => {
  const run = load({ extra: { RETRIES: [40, 40, 40, 40], QUIET_MS: 400 } });
  await sleep(40);
  run.app.bounds.maxLeft = 1900;
  run.app.push(0, 0);
  await sleep(600);                                           // tries that get nowhere, 40 ms apart
  const presses = run.app.emitted.filter(e => e.payload?.action === 'press').map(e => e.at);
  assert.ok(presses.length >= 3, `tried again and again: ${presses.length}`);
  const gaps = presses.slice(1).map((t, i) => t - presses[i]);
  assert.ok(Math.max(...gaps) < 300, `not held up for the quiet time (400 ms) by its own events: ${gaps.join(', ')}`);
});

test('a press when the pet cannot be found is not a place: a later release does not take one', async () => {
  const run = load();
  await sleep(40);
  run.app.hidden = true;                                      // the page has no pet at the moment of the press
  run.person.press();
  run.app.hidden = false;
  run.app.dock = { left: 1000, top: 500 };
  run.person.release();
  await sleep(250);
  assert.equal(run.stored().pets.me.left, 2325, 'nothing was remembered');
});

test('after the old place is let go and before the new one is taken, it says there is none and does nothing', async () => {
  const storage = new FakeStorage();
  storage.setItem(SETTINGS_KEY, JSON.stringify({ position: 'bottomRight', petScale: 75 }));
  const run = load({ storage, extra: { SETTINGS_ACCEPT_MS: 2000 } });                 // the new place is taken 1.5 s after the change
  await sleep(40);
  run.storage.setItem(SETTINGS_KEY, JSON.stringify({ position: 'topLeft', petScale: 75 }));
  await sleep(60);
  assert.equal(run.stored(), null);
  assert.equal(run.live.state, '还没有记住位置：把桌宠拖到想要的位置就会记住');
  assert.equal(run.live.remembered, '还没有');
  assert.deepEqual(run.emitted(), []);
  assert.deepEqual(run.warnings, [], 'and nothing went wrong');
});

test('while the mouse is moving it does not start, and goes on when the mouse is still', async () => {
  const run = load();
  await sleep(40);
  run.app.bounds.maxLeft = 2000;
  run.app.push(0, 0);
  run.app.bounds.maxLeft = 2325;
  for (let i = 0; i < 20; i += 1) { run.person.wiggle(10 + i, 10); await sleep(15); }          // the mouse moves for 300 ms
  assert.deepEqual(run.emitted(), [], 'not while it moves');
  assert.equal(run.live.state, '桌宠不在记住的位置，等鼠标停下来再拖回去', 'and it says it is waiting, and for what');
  await sleep(700);
  at(run, 2325, 1061);
});

test('if the mouse starts moving in the middle of the drag it lets go at once, does not count it as a failed try, and tries again soon', async () => {
  const run = load({ extra: { STEP_MS: 20, STEPS: 8 } });
  await sleep(40);
  run.app.bounds.maxLeft = 2000;
  run.app.push(0, 0);
  run.app.bounds.maxLeft = 2325;
  await until(() => run.emitted().includes('mouse-button:press'));
  await sleep(50);
  run.person.wiggle(777, 555);                                // the real mouse
  await until(() => run.emitted().includes('mouse-button:release'));
  const moves = run.emitted().filter(e => e === 'mouse-move').length;
  assert.ok(moves < 9, `it stopped moving: ${moves} moves of at most 9`);
  assert.equal(run.app.drag, null, 'and let go');
  assert.ok(await until(() => run.live.state === '鼠标在动，稍后再把桌宠拖回去'), 'it says why');
  assert.ok(await until(() => run.app.dock.left === 2325, 4000), 'and it was brought back when the mouse was still');
});

test('what it sent itself, coming back, is not taken for the mouse moving', async () => {
  const run = load({ extra: { MOVE_QUIET_MS: 600 } });
  await sleep(40);
  run.app.bounds.maxLeft = 2000;
  run.app.push(0, 0);
  run.app.bounds.maxLeft = 2325;
  assert.ok(await until(() => run.app.dock.left === 2325, 4000), 'it brought the pet back');
  const presses = run.emitted().filter(e => e === 'mouse-button:press').length;
  assert.equal(presses, 1, 'in one go: its own moves did not stop it');
});

test('the way back, part of the way or all of it, never leaves the app saving a place that is not the remembered one', async () => {
  const storage = new FakeStorage();
  storage.setItem(PLACEMENT_KEY, placementOf({ left: 2325, top: 1061 }));
  const run = load({ storage });
  await sleep(40);
  const kept = run.storage.getItem(PLACEMENT_KEY);
  run.app.bounds.maxLeft = 1900;
  run.app.push(0, 0);
  run.app.bounds.maxLeft = 2100;                              // part of the way
  assert.ok(await until(() => run.app.dock.left === 2100, 3000));
  await sleep(150);
  assert.equal(run.storage.getItem(PLACEMENT_KEY), kept, 'the place it came to on the way is not what the app keeps');
  run.app.bounds.maxLeft = 2325;                              // all of the way
  assert.ok(await until(() => run.app.dock.left === 2325, 4000));
  await sleep(150);
  assert.equal(run.storage.getItem(PLACEMENT_KEY), kept, 'and at the end it is what it was');
});

test('a click on the pet, and the room pushing it a moment later, is not a place the person chose', async () => {
  const run = load();
  await sleep(40);
  run.person.press();
  run.person.release();                                       // a click: nothing moved while the button was down
  run.app.bounds.maxLeft = 1900;
  run.app.push(0, 0);                                         // and now the room pushes the pet
  await sleep(260);                                           // past the time a drag would be settled
  assert.equal(run.stored().pets.me.left, 2325, 'what is remembered is not the pushed place');
});

test('the app saved a place on its own in the time the person had just touched the mouse: when the pet is back, what the app keeps is put right', async () => {
  const storage = new FakeStorage();
  storage.setItem(PLACEMENT_KEY, placementOf({ left: 2325, top: 1061 }));
  const run = load({ storage });
  await sleep(40);
  const kept = run.storage.getItem(PLACEMENT_KEY);
  run.person.press();
  run.person.release();                                       // the mouse was touched: the app's saving is let through for a moment
  run.app.bounds.maxLeft = 1900;
  run.app.push(0, 0);                                         // and the app saves the pushed place in that moment
  assert.equal(run.storage.getItem(PLACEMENT_KEY), placementOf({ left: 1900, top: 1061 }), 'it did get through');
  run.app.bounds.maxLeft = 2325;
  assert.ok(await until(() => run.app.dock.left === 2325, 4000), 'the pet comes back');
  await sleep(150);
  assert.equal(run.storage.getItem(PLACEMENT_KEY), kept, 'and what the app keeps is the remembered place again');
});

// --- the other players' pets ----------------------------------------------------------------------------------

const v2 = (pets, layout = { vw: 2560, vh: 1440, scale: 0.75 }, placement = null) => JSON.stringify({ v: 2, layout, placement, pets: Object.fromEntries(Object.entries(pets).map(([id, [left, top]]) => [id, { left, top, at: 1 }])) });
const withFriends = friends => app => { for (const [id, [left, top]] of Object.entries(friends)) app.join(id, left, top); };
const friendAt = (run, id, left, top) => assert.deepEqual({ left: run.app.friends.get(id).left, top: run.app.friends.get(id).top }, { left, top }, `player ${id}`);

test('a drag of another player\'s pet by the person is remembered by the player, and nothing else changes', async () => {
  const run = load({ prepare: withFriends({ 95007: [1239, 1181], 110283: [1111, 1181] }) });
  await sleep(40);
  await run.person.drag(-400, -300, '95007');
  await sleep(250);
  friendAt(run, '95007', 839, 881);
  friendAt(run, '110283', 1111, 1181);
  assert.deepEqual(Object.keys(run.stored().pets).sort(), ['95007', 'me'], 'the one that was dragged, and the person\'s own');
  assert.deepEqual([run.stored().pets['95007'].left, run.stored().pets['95007'].top], [839, 881]);
  assert.equal(run.stored().pets.me.left, 2325, 'the person\'s own place is the same');
  assert.equal(run.live.remembered, '左 2325，上 1061；1 位玩家的桌宠');
  assert.deepEqual(run.emitted(), [], 'nothing is "fixed"');
});

test('a click on another player\'s pet, with no move, is not a place', async () => {
  const run = load({ prepare: withFriends({ 95007: [1239, 1181] }) });
  await sleep(40);
  await run.person.drag(0, 0, '95007');
  await sleep(250);
  assert.deepEqual(Object.keys(run.stored().pets), ['me']);
});

test('after entering a room, a player\'s pet put in a slot is dragged to the place the person set before', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2325, 1061], 95007: [839, 881] }, undefined, placementOf({ left: 2325, top: 1061 })));
  const run = load({ storage, prepare: withFriends({ 95007: [1239, 1181] }) });             // the app slotted the pet
  assert.ok(await until(() => run.app.friends.get('95007').left === 839, 4000), 'it was brought back');
  friendAt(run, '95007', 839, 881);
  at(run, 2325, 1061);
  assert.ok(await until(() => run.live.state === '已把玩家的桌宠拖回记住的位置'), 'and it says so, once it has looked');
  assert.equal(run.app.friendDrags, 1, 'by one drag of that pet');
  assert.equal(run.storage.getItem(PLACEMENT_KEY), placementOf({ left: 2325, top: 1061 }), 'the person\'s own pet\'s place was not touched');
});

test('a player who leaves and comes in again is put back where the person set the pet, every time', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2325, 1061], 95007: [839, 881] }));
  const run = load({ storage, prepare: withFriends({ 95007: [839, 881] }) });
  await sleep(100);
  assert.deepEqual(run.emitted(), [], 'in its place: nothing to do');
  assert.equal(run.live.state, '桌宠在记住的位置');
  run.app.friends.delete('95007');                           // the player leaves
  await sleep(60);
  run.app.join('95007', 1500, 1181);                          // and comes in again, in a slot
  assert.ok(await until(() => run.app.friends.get('95007').left === 839, 4000));
  friendAt(run, '95007', 839, 881);
  assert.ok(run.stored().pets['95007'], 'and it is still remembered');
});

test('several pets elsewhere are brought back one at a time, the person\'s own first', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2000, 900], 95007: [100, 100], 110283: [300, 100] }));
  const run = load({ storage, prepare: withFriends({ 95007: [1239, 1181], 110283: [1111, 1181] }) });
  assert.ok(await until(() => run.app.dock.left === 2000 && run.app.friends.get('95007').left === 100 && run.app.friends.get('110283').left === 300 && run.app.drag === null, 8000), 'all of them');
  await sleep(150);
  const presses = run.app.emitted.filter(e => e.payload?.action === 'press').length;
  assert.equal(presses, 3, 'one drag for each');
  assert.deepEqual(run.app.picked, ['me', '95007', '110283'], 'the own pet first, then the others by id, one drag at a time');
  assert.equal(run.app.drag, null);
});

test('one pet that cannot get to its place does not hold up the others, and is tried again later', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2325, 1061], 95007: [5000, 100], 110283: [300, 100] }));       // the first place is outside the screen: the app keeps it inside
  const run = load({ storage, prepare: withFriends({ 95007: [1239, 1181], 110283: [1111, 1181] }) });
  assert.ok(await until(() => run.app.friends.get('110283').left === 300, 8000), 'the other one got there');
  assert.ok(await until(() => run.app.emitted.filter(e => e.payload?.action === 'press').length >= 4, 8000), 'the first is tried again');
  const attempts = run.app.emitted.filter(e => e.payload?.action === 'press').length;
  await sleep(300);
  assert.ok(run.app.emitted.filter(e => e.payload?.action === 'press').length - attempts <= 2, 'not in a loop');
});

test('a pet whose body is under another is not dragged at: the other one would be picked up', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2325, 1061], 95007: [100, 100] }));
  const run = load({ storage, prepare: withFriends({ 95007: [1239, 1181], 110283: [1239, 1181] }) });      // 110283 came last and is on top
  await sleep(500);
  assert.deepEqual(run.emitted(), []);
  friendAt(run, '110283', 1239, 1181);
  assert.match(run.live.state, /点不到它/);
});

test('a pet that has not been put in the room yet is not looked at', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2325, 1061], 95007: [100, 100] }));
  const run = load({ storage, prepare: app => app.friends.set('95007', { left: 1239, top: 1181, positioned: false }) });
  await sleep(400);
  assert.deepEqual(run.emitted(), []);
});

test('with the switch for the others off, only the person\'s own pet is remembered and brought back', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2000, 900], 95007: [100, 100] }));
  const run = load({ storage, config: { others: false }, prepare: withFriends({ 95007: [1239, 1181] }) });
  assert.ok(await until(() => run.app.dock.left === 2000, 4000));
  await sleep(300);
  friendAt(run, '95007', 1239, 1181);
  await run.person.drag(-100, 0, '95007');
  await sleep(250);
  assert.deepEqual([run.stored().pets['95007'].left, run.stored().pets['95007'].top], [100, 100], 'what was kept before is left alone, and the new place is not taken');
});

test('what is remembered of the others is kept across a restart', async () => {
  const first = load({ prepare: withFriends({ 95007: [1239, 1181] }) });
  await sleep(40);
  await first.person.drag(-400, -300, '95007');
  await sleep(250);
  first.dispose();
  const second = load({ storage: first.storage, prepare: withFriends({ 95007: [1239, 1181] }) });             // started again, the pet in the slot
  assert.ok(await until(() => second.app.friends.get('95007').left === 839, 4000));
  friendAt(second, '95007', 839, 881);
});

test('the places of a layout that is not this one are not used, for any pet', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2325, 1061], 95007: [100, 100] }, { vw: 1920, vh: 1080, scale: 0.75 }));
  const run = load({ storage, prepare: withFriends({ 95007: [1239, 1181] }) });
  await sleep(400);
  assert.deepEqual(run.emitted(), []);
  assert.equal(run.live.state, '屏幕或桌宠大小变了，之前记的位置不再用');
});

test('a place kept by the first version, for the person\'s own pet, is read, and written again as it is now', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, JSON.stringify({ left: 2000, top: 900, vw: 2560, vh: 1440, scale: 0.75, placement: placementOf({ left: 2000, top: 900 }) }));
  const run = load({ storage, prepare: withFriends({ 95007: [1239, 1181] }), config: { restore: false } });
  await sleep(100);
  assert.equal(run.live.remembered, '左 2000，上 900');
  await run.person.drag(-400, -300, '95007');
  await sleep(250);
  assert.equal(run.stored().v, 2);
  assert.deepEqual([run.stored().pets.me.left, run.stored().pets.me.top], [2000, 900]);
  assert.ok(run.stored().pets['95007']);
});

test('"take the places the pets are at now" takes every pet\'s place', async () => {
  const run = load({ prepare: withFriends({ 95007: [1239, 1181], 110283: [1111, 1181] }) });
  await sleep(40);
  run.app.place('95007', 10, 20);
  run.app.dock = { left: 100, top: 100 };
  for (const fn of run.listeners.get('storage') ?? []) fn({ key: NOW_KEY, newValue: '123' });
  assert.deepEqual(Object.keys(run.stored().pets).sort(), ['110283', '95007', 'me']);
  assert.deepEqual([run.stored().pets['95007'].left, run.stored().pets['95007'].top], [10, 20]);
  assert.equal(run.live.remembered, '左 100，上 100；2 位玩家的桌宠');
});

test('only the sixty most recently set places of the others are kept', async () => {
  const pets = { me: [2325, 1061] };
  for (let i = 1; i <= 65; i += 1) pets[`p${i}`] = [i, i];
  const storage = new FakeStorage();
  storage.setItem(STORE, JSON.stringify({ v: 2, layout: { vw: 2560, vh: 1440, scale: 0.75 }, placement: null, pets: Object.fromEntries(Object.entries(pets).map(([id, [left, top]], n) => [id, { left, top, at: n + 1 }])) }));
  const run = load({ storage, prepare: withFriends({ 95007: [1239, 1181] }), config: { restore: false } });
  await sleep(40);
  await run.person.drag(-400, -300, '95007');
  await sleep(250);
  const kept = Object.keys(run.stored().pets);
  assert.equal(kept.length, 61, 'the person\'s own and sixty');
  assert.ok(kept.includes('95007') && kept.includes('me'));
  assert.ok(!kept.includes('p1') && !kept.includes('p6'), 'the oldest went');
  assert.ok(kept.includes('p7'));
});

test('a drag of another player\'s pet does not move the person\'s own, and neither is taken for the other', async () => {
  const run = load({ prepare: withFriends({ 95007: [1239, 1181] }) });
  await sleep(40);
  await run.person.drag(-100, -100, '95007');
  await sleep(250);
  await run.person.drag(-50, -50, 'me');
  await sleep(250);
  assert.deepEqual([run.stored().pets.me.left, run.stored().pets.me.top], [2275, 1011]);
  assert.deepEqual([run.stored().pets['95007'].left, run.stored().pets['95007'].top], [1139, 1081]);
});
