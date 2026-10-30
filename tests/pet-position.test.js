// mods/pet-position, run against a stand-in for what the loader opens of the app (`mod.app`): the person's own pet and
// other players' pets with places that can be read and set, the app's own saving of the person's pet's place, the
// room pushing pets around, and the person dragging a pet (which the app announces). Nothing here touches the real
// app.
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
const TRAIL_KEY = 'modkit-pet-position-trail';

// The waits are seconds long; a test cannot wait that. Each constant is replaced, and each has to have been found.
const FAST = {
  CHECK_MS: 20, START_WAIT_MS: 0, SETTLE_MS: 40, VERIFY_MS: 60, QUIET_MS: 60, HEAL_QUIET_MS: 80, NEW_PLACE_MS: 200, NOTICE_MS: 300, TOLERANCE_PX: 2,
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

class FakeStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

const placementOf = ({ left, top }) => JSON.stringify({ at: [left, top] });
const v2 = (pets, layout = { vw: 2560, vh: 1440, scale: 0.75 }, placement = null) => JSON.stringify({ v: 2, layout, placement, pets: Object.fromEntries(Object.entries(pets).map(([id, [left, top]]) => [id, { left, top, at: 1 }])) });

// The app as the plugin sees it through `mod.app`.
function makeApp(storage, options = {}) {
  const app = {
    available: options.available ?? true,
    status: null,
    pet: { left: 2325, top: 1061 },
    bounds: { maxLeft: 2325, maxTop: 1061 },                 // what is free: the person's own pet is kept inside
    members: new Map(),                                     // id -> { id, left, top, draggable, positioned }
    vw: 2560, vh: 1440, scale: 0.75,
    saves: 0,
    moves: [],                                              // everything set through the API
    stubborn: false,                                        // the app puts a pet back where it was a moment after
    handlers: { pet: [], members: [] },
    clamp(place) { return { left: Math.min(this.bounds.maxLeft, Math.max(0, place.left)), top: Math.min(this.bounds.maxTop, Math.max(0, place.top)) }; },
    saveKey() { this.saves += 1; storage.setItem(PLACEMENT_KEY, placementOf(this.pet)); },
    join(id, left, top, extra = {}) { this.members.set(String(id), { id: Number(id), left, top, draggable: true, positioned: true, ...extra }); },
    leave(id) { this.members.delete(String(id)); },
    // the room (or the taskbar) pushes the person's pet, and the app saves where it ended up
    push(dx, dy, { save = true } = {}) { this.pet = this.clamp({ left: this.pet.left + dx, top: this.pet.top + dy }); if (save) this.saveKey(); },
    // the person drags a pet and lets go: the app saves its own pet's place 40 ms later and says so
    // (the app saves 380 ms after the drag, and says so 20 ms after that: here 10 and 30)
    dragPet(left, top) {
      this.pet = this.clamp({ left, top });
      setTimeout(() => this.saveKey(), 10);
      setTimeout(() => this.handlers.pet.forEach(fn => fn()), 30);
    },
    dragMember(id, left, top) {
      Object.assign(this.members.get(String(id)), { left, top });
      setTimeout(() => this.handlers.members.forEach(fn => fn(Number(id))), 30);
    },
  };
  return app;
}

function load({ storage = new FakeStorage(), config = {}, extra = {}, appOptions = {}, prepare = null, noApp = false, started = true } = {}) {
  const localStorage = storage;
  const app = makeApp(storage, appOptions);
  prepare?.(app, localStorage);
  if (localStorage.getItem(PLACEMENT_KEY) === null) localStorage.setItem(PLACEMENT_KEY, placementOf(app.pet));        // the app has saved where its pet is
  const settings = { restore: true, ...config };
  const live = {};
  const logs = [];
  const warnings = [];
  const disposers = [];
  const listeners = new Map();
  const events = new Map();

  const modApp = {
    available: () => app.available,
    status: () => app.status,
    pet: {
      position: () => (app.available ? { ...app.pet } : null),
      move(left, top) {
        if (!app.available) return false;
        app.moves.push({ id: 'me', left, top });
        app.pet = app.clamp({ left, top });
        app.saveKey();
        if (app.stubborn) setTimeout(() => { app.pet = { left: 100, top: 100 }; }, 10);
        return true;
      },
      onDragged(fn) { app.handlers.pet.push(fn); return () => app.handlers.pet.splice(app.handlers.pet.indexOf(fn), 1); },
    },
    members: {
      list: () => [...app.members.values()].map(({ id, left, top, draggable }) => ({ id, left, top, draggable })),
      place(id, left, top) {
        const member = app.members.get(String(id));
        if (!member || !member.draggable) return false;
        app.moves.push({ id: String(id), left, top });
        Object.assign(member, { left, top });
        if (app.stubborn) setTimeout(() => Object.assign(member, { left: 100, top: 100 }), 10);
        return true;
      },
      clamp: (left, top) => ({ left, top }),
      onDragged(fn) { app.handlers.members.push(fn); return () => app.handlers.members.splice(app.handlers.members.indexOf(fn), 1); },
    },
  };

  const mod = {
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => warnings.push(a.join(' ')),
    live: (key, value) => { live[key] = value; },
    onDispose: fn => disposers.push(fn),
    config: { get: key => settings[key] },
    onEvent: (name, fn) => { events.set(name, [...(events.get(name) ?? []), fn]); },
    app: noApp ? undefined : modApp,
  };
  const document = {
    documentElement: {},
    querySelector: selector => {
      const id = /data-room-cat-id="([^"]+)"/.exec(selector)?.[1];
      const member = id === undefined ? null : app.members.get(id);
      return member ? { dataset: { roomCatPositioned: member.positioned ? 'true' : 'false' } } : null;
    },
  };
  const window = {
    get innerWidth() { return app.vw; },
    get innerHeight() { return app.vh; },
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter(f => f !== fn)),
  };
  const getComputedStyle = () => ({ getPropertyValue: () => String(app.scale) });

  const person = {
    press() { (events.get('mouse-button') ?? []).forEach(fn => fn({ payload: { button: 'left', action: 'press' } })); },
    release() { (events.get('mouse-button') ?? []).forEach(fn => fn({ payload: { button: 'left', action: 'release' } })); },
  };

  // a drag is made with the button held: the hook tells the plugin, and the button is up again before the app says so
  for (const name of ['dragPet', 'dragMember']) {
    const drag = app[name].bind(app);
    app[name] = (...args) => { person.press(); setTimeout(() => person.release(), 5); drag(...args); };
  }

  const run = {
    app, storage, settings, live, logs, warnings, listeners, person, modApp,
    stored: () => JSON.parse(localStorage.getItem(STORE) ?? 'null'),
    trail: () => JSON.parse(localStorage.getItem(TRAIL_KEY) ?? '[]'),
    dispose: () => disposers.forEach(fn => fn()),
    start: () => new AsyncFunction('mod', 'document', 'window', 'localStorage', 'getComputedStyle', fastSource(extra))(mod, document, window, localStorage, getComputedStyle),
  };
  if (started) run.start();
  running.push(run);
  return run;
}

const at = (run, left, top) => assert.deepEqual(run.app.pet, { left, top });
const memberAt = (run, id, left, top) => assert.deepEqual({ left: run.app.members.get(String(id)).left, top: run.app.members.get(String(id)).top }, { left, top }, `player ${id}`);
const withFriends = friends => app => { for (const [id, [left, top]] of Object.entries(friends)) app.join(id, left, top); };

test('what it declares and shows: the permission it needs, the api it is written for, and no person words', () => {
  assert.deepEqual(manifest.modkit.permissions, ['app-internals']);
  assert.equal(manifest.modkit.api, 2);
  assert.equal(manifest.modkit.defaultEnabled, undefined, 'it is on: it only moves the pets');
  assert.deepEqual(manifest.modkit.settings.map(s => s.key), ['restore', 'others', 'remembered', 'state']);
  const code = (original + panelSource).split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  const strings = [...code.matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)].map(m => m[1] ?? m[2]).filter(text => /[一-鿿]/.test(text));
  for (const text of [manifest.description, manifest.displayName, ...manifest.modkit.settings.flatMap(s => [s.title, s.description, typeof s.default === 'string' ? s.default : null]), ...strings].filter(Boolean)) {
    assert.ok(!/[我咱您你她]|(?<!其)他/.test(text), `a person word in "${text}"`);
  }
  assert.ok(!/fetch\(|XMLHttpRequest|new WebSocket/.test(code), 'it sends nothing anywhere');
  assert.ok(!/plugin:event\|emit|mouse-move/.test(code), 'and it does not pretend to be the mouse');
  assert.ok(!/Storage\.prototype/.test(code), 'nor change how the page stores things');
});

test('the waits it really has are pinned here: what the tests shorten', () => {
  for (const line of ['const CHECK_MS = 1000;', 'const START_WAIT_MS = 1500;', 'const SETTLE_MS = 900;', 'const VERIFY_MS = 1500;', 'const QUIET_MS = 1500;', 'const HEAL_QUIET_MS = 3000;', 'const NEW_PLACE_MS = 6000;', 'const TOLERANCE_PX = 2;', 'const NOTICE_MS = 10_000;', 'const RETRY_MS = [3000, 10_000, 60_000, 300_000];']) {
    assert.ok(original.includes(line), `${line} is the real value`);
  }
});

test('started with nothing remembered, it takes the place the pet is at, and says so', async () => {
  const run = load();
  assert.ok(await until(() => run.stored()));
  const stored = run.stored();
  assert.equal(stored.v, 2);
  assert.deepEqual(stored.layout, { vw: 2560, vh: 1440, scale: 0.75 });
  assert.deepEqual(Object.keys(stored.pets), ['me'], 'the places of the others are not taken until the person drags them');
  assert.deepEqual([stored.pets.me.left, stored.pets.me.top], [2325, 1061]);
  assert.equal(run.live.remembered, '左 2325，上 1061');
  await sleep(60);
  assert.equal(run.live.state, '桌宠在记住的位置');
  assert.deepEqual(run.app.moves, [], 'nothing is moved');
});

test('a drag of the person\'s own pet is remembered, with the place the app saved for it', async () => {
  const run = load();
  await sleep(60);
  run.app.dragPet(2025, 861);
  await sleep(200);
  assert.deepEqual([run.stored().pets.me.left, run.stored().pets.me.top], [2025, 861]);
  assert.equal(run.stored().placement, placementOf({ left: 2025, top: 861 }), 'and what the app keeps for its next start goes with it');
  assert.equal(run.live.remembered, '左 2025，上 861');
  assert.deepEqual(run.app.moves, [], 'the person\'s own drag is not "fixed"');
});

test('a drag of another player\'s pet is remembered by the player, and nothing else changes', async () => {
  const run = load({ prepare: withFriends({ 95007: [1239, 1181], 110283: [1111, 1181] }) });
  await sleep(60);
  run.app.dragMember(95007, 839, 881);
  await sleep(200);
  assert.deepEqual(Object.keys(run.stored().pets).sort(), ['95007', 'me']);
  assert.deepEqual([run.stored().pets['95007'].left, run.stored().pets['95007'].top], [839, 881]);
  assert.equal(run.stored().pets.me.left, 2325, 'the person\'s own place is the same');
  assert.equal(run.live.remembered, '左 2325，上 1061；1 位玩家的桌宠');
  assert.deepEqual(run.app.moves, []);
});

test('a pet that something else moves is not a place the person chose: only what the app says was dragged is taken', async () => {
  const run = load({ prepare: withFriends({ 95007: [1239, 1181], 110283: [1111, 1181] }) });
  await sleep(60);
  run.app.members.get('110283').left = 500;               // the app arranges it
  run.app.push(-300, 0, { save: false });                 // and pushes the person's own pet
  await sleep(100);
  assert.deepEqual(Object.keys(run.stored().pets), ['me']);
  assert.equal(run.stored().pets.me.left, 2325);
});

test('pushed away by something, the pet is put back at once and directly, with nothing sent to the mouse', async () => {
  const run = load();
  await sleep(60);
  run.app.dragPet(2025, 861);
  await sleep(200);
  run.app.bounds.maxLeft = 1900;                          // the room takes the right side: the pet is pushed
  run.app.push(0, 0);
  assert.ok(run.app.pet.left < 2025, 'it was pushed');
  run.app.bounds.maxLeft = 2325;                          // and the room is left
  assert.ok(await until(() => run.app.pet.left === 2025), 'it is put back');
  at(run, 2025, 861);
  assert.deepEqual(run.app.moves, [{ id: 'me', left: 2025, top: 861 }], 'by one setting of the place');
  assert.equal(run.live.state, '已把桌宠放回记住的位置');
  assert.equal(run.stored().pets.me.left, 2025, 'what is remembered is the same');
  await sleep(400);
  assert.equal(run.live.state, '桌宠在记住的位置', 'and after a while it says the pet is in the place');
});

test('the app saved a place of its own when it pushed the pet: the key it starts from is put back once the pet is, but the saving of a drag is not undone', async () => {
  const run = load();
  await sleep(60);
  run.app.dragPet(2025, 861);
  await sleep(200);
  const kept = run.storage.getItem(PLACEMENT_KEY);
  assert.equal(kept, placementOf({ left: 2025, top: 861 }));
  run.app.bounds.maxLeft = 1900;
  run.app.push(0, 0);                                     // the app pushes its pet and saves where it ended up
  assert.notEqual(run.storage.getItem(PLACEMENT_KEY), kept);
  assert.ok(await until(() => run.storage.getItem(PLACEMENT_KEY) === kept), 'the person\'s place is the key again');
  assert.match(run.trail().join('\n'), /已改回亲手拖好的位置/);

  const second = load();
  await sleep(60);
  second.app.dragPet(1500, 600);                          // a new drag: the app saves it 40 ms later, inside the quiet time
  await sleep(200);
  assert.equal(second.storage.getItem(PLACEMENT_KEY), placementOf({ left: 1500, top: 600 }), 'the person\'s new drag was not undone');
  assert.equal(second.stored().pets.me.left, 1500);
});

test('after entering a room, a player\'s pet put in a slot is set to the place the person set before', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2325, 1061], 95007: [839, 881] }, undefined, placementOf({ left: 2325, top: 1061 })));
  const run = load({ storage, prepare: withFriends({ 95007: [1239, 1181] }) });           // the app slotted the pet
  assert.ok(await until(() => run.app.members.get('95007').left === 839));
  memberAt(run, 95007, 839, 881);
  at(run, 2325, 1061);
  assert.equal(run.live.state, '已把玩家的桌宠放回记住的位置');
  assert.deepEqual(run.app.moves, [{ id: '95007', left: 839, top: 881 }]);
});

test('a pet the app has not put in the room yet is left alone; it is set once it is', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2325, 1061], 95007: [839, 881] }));
  const run = load({ storage, prepare: app => app.join(95007, 1239, 1181, { positioned: false }) });
  await sleep(150);
  assert.deepEqual(run.app.moves, []);
  run.app.members.get('95007').positioned = true;
  assert.ok(await until(() => run.app.members.get('95007').left === 839));
});

test('a player who leaves and comes in again is set to where the person put the pet, every time', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2325, 1061], 95007: [839, 881] }));
  const run = load({ storage, prepare: withFriends({ 95007: [839, 881] }) });
  await sleep(100);
  assert.deepEqual(run.app.moves, [], 'in its place: nothing to do');
  run.app.leave(95007);
  await sleep(60);
  run.app.join(95007, 1500, 1181);
  assert.ok(await until(() => run.app.members.get('95007').left === 839));
  assert.ok(run.stored().pets['95007'], 'and it is still remembered');
});

test('several pets elsewhere are all set, and a pet that cannot be moved is told, not retried in a loop', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2000, 900], 95007: [100, 100], 110283: [300, 100], 39196: [400, 100] }));
  const run = load({ storage, prepare: app => { app.join(95007, 1239, 1181); app.join(110283, 1111, 1181); app.join(39196, 972, 1181, { draggable: false }); } });
  assert.ok(await until(() => run.app.pet.left === 2000 && run.app.members.get('95007').left === 100 && run.app.members.get('110283').left === 300));
  await sleep(100);
  assert.equal(run.app.moves.filter(m => m.id === '39196').length, 0, 'one that cannot be dragged is not considered a pet with a place');
});

test('a place the app will not keep is tried again later and later, not in a loop, and given up on quietly when it holds', async () => {
  const run = load({ extra: { RETRIES: [60, 120, 240, 480] } });
  await sleep(60);
  run.app.dragPet(2025, 861);
  await sleep(200);
  run.app.stubborn = true;                                // the app puts the pet back where it was, a moment after each try
  run.app.pet = { left: 100, top: 100 };
  await sleep(900);
  const tries = run.app.moves.length;
  assert.ok(tries >= 3 && tries <= 6, `a few tries, each after a longer wait: ${tries}`);
  assert.equal(run.live.state, '桌宠没能留在记住的位置（那里可能被占着），稍后再试');
  run.app.stubborn = false;                               // the room is left
  assert.ok(await until(() => run.app.pet.left === 2025, 3000), 'it holds once there is room');
});

test('while the person holds a mouse button it does not move a pet, and goes on a moment after', async () => {
  const run = load();
  await sleep(60);
  run.app.dragPet(2025, 861);
  await sleep(200);
  run.person.press();
  run.app.bounds.maxLeft = 1900;
  run.app.push(0, 0);
  await sleep(150);
  assert.deepEqual(run.app.moves, [], 'not while a button is held');
  assert.equal(run.live.state, '桌宠不在记住的位置，等鼠标松开再放回去');
  run.app.bounds.maxLeft = 2325;
  run.person.release();
  await sleep(20);
  assert.deepEqual(run.app.moves, [], 'and not at the very moment it goes up');
  assert.ok(await until(() => run.app.pet.left === 2025));
});

test('with the switch off it only keeps the saved place, and says the pet is elsewhere', async () => {
  const run = load({ config: { restore: false } });
  await sleep(60);
  run.app.bounds.maxLeft = 2000;
  run.app.push(0, 0);
  await sleep(200);
  assert.deepEqual(run.app.moves, []);
  assert.equal(run.live.state, '桌宠不在记住的位置（已设为不自动放回）');
  assert.equal(run.stored().pets.me.left, 2325, 'and what is remembered did not follow the push');
});

test('with the switch for the others off, only the person\'s own pet is remembered and set', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2000, 900], 95007: [100, 100] }));
  const run = load({ storage, config: { others: false }, prepare: withFriends({ 95007: [1239, 1181] }) });
  assert.ok(await until(() => run.app.pet.left === 2000));
  await sleep(150);
  memberAt(run, 95007, 1239, 1181);
  run.app.dragMember(95007, 500, 500);
  await sleep(200);
  assert.deepEqual([run.stored().pets['95007'].left, run.stored().pets['95007'].top], [100, 100], 'what was kept before is left alone, and the new place is not taken');
});

test('when the screen or the pet\'s size is not what it was, the old places are not used, for any pet', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, v2({ me: [2000, 900], 95007: [100, 100] }, { vw: 1920, vh: 1080, scale: 0.75 }));
  const run = load({ storage, prepare: withFriends({ 95007: [1239, 1181] }) });
  await sleep(200);
  assert.deepEqual(run.app.moves, []);
  assert.equal(run.live.state, '屏幕或桌宠大小变了，之前记的位置不再用');
});

test('where the pet goes, set in the app\'s settings, is the person\'s choice: the old place is let go and the new one taken', async () => {
  const storage = new FakeStorage();
  storage.setItem(SETTINGS_KEY, JSON.stringify({ position: 'bottomRight', petScale: 75, windowOpacity: 100 }));
  const run = load({ storage });
  await sleep(80);
  run.storage.setItem(SETTINGS_KEY, JSON.stringify({ position: 'bottomRight', petScale: 75, windowOpacity: 60 }));      // the opacity: not a place
  await sleep(80);
  assert.ok(run.stored(), 'the place is kept');
  run.storage.setItem(SETTINGS_KEY, JSON.stringify({ position: 'topLeft', petScale: 75, windowOpacity: 60 }));          // the corner
  await sleep(60);
  assert.equal(run.stored(), null, 'the old place is let go');
  assert.equal(run.live.remembered, '还没有');
  run.app.pet = { left: 12, top: 20 };                    // the app moves the pet to the corner and saves it
  run.app.saveKey();
  assert.ok(await until(() => run.stored()?.pets.me.left === 12, 2000), 'the corner is the place now');
  assert.deepEqual(run.app.moves, [], 'and the pet is not set back');
});

test('"take the places the pets are at now", asked by the panel, takes every pet', async () => {
  const run = load({ prepare: withFriends({ 95007: [1239, 1181], 110283: [1111, 1181] }) });
  await sleep(60);
  run.app.members.get('95007').left = 10;
  run.app.pet = { left: 100, top: 100 };
  for (const fn of run.listeners.get('storage') ?? []) fn({ key: NOW_KEY, newValue: '123' });
  assert.deepEqual(Object.keys(run.stored().pets).sort(), ['110283', '95007', 'me']);
  assert.equal(run.stored().pets['95007'].left, 10);
  assert.equal(run.live.remembered, '左 100，上 100；2 位玩家的桌宠');
  assert.equal(run.live.state, '已把现在的位置记下来');
  for (const fn of run.listeners.get('storage') ?? []) fn({ key: NOW_KEY, newValue: null });          // the panel taking its request away
  assert.equal(run.stored().pets.me.left, 100);
});

test('a place kept by the first version, for the person\'s own pet, is read, and what is kept is read again after a restart', async () => {
  const storage = new FakeStorage();
  storage.setItem(STORE, JSON.stringify({ left: 2000, top: 900, vw: 2560, vh: 1440, scale: 0.75, placement: placementOf({ left: 2000, top: 900 }) }));
  const first = load({ storage, prepare: withFriends({ 95007: [1239, 1181] }) });
  assert.ok(await until(() => first.app.pet.left === 2000), 'it is put there');
  first.app.dragMember(95007, 700, 700);
  await sleep(200);
  assert.equal(first.stored().v, 2);
  first.dispose();
  const second = load({ storage, prepare: withFriends({ 95007: [1239, 1181] }) });             // started again, the pet in the slot
  assert.ok(await until(() => second.app.members.get('95007').left === 700));
  assert.equal(second.app.pet.left, 2000);
});

test('only the sixty most recently set places of the others are kept', async () => {
  const pets = { me: [2325, 1061] };
  for (let i = 1; i <= 65; i += 1) pets[`p${i}`] = [i, i];
  const storage = new FakeStorage();
  storage.setItem(STORE, JSON.stringify({ v: 2, layout: { vw: 2560, vh: 1440, scale: 0.75 }, placement: null, pets: Object.fromEntries(Object.entries(pets).map(([id, [left, top]], n) => [id, { left, top, at: n + 1 }])) }));
  const run = load({ storage, config: { restore: false }, prepare: withFriends({ 95007: [1239, 1181] }) });
  await sleep(60);
  run.app.dragMember(95007, 500, 500);
  await sleep(200);
  const kept = Object.keys(run.stored().pets);
  assert.equal(kept.length, 61, 'the person\'s own and sixty');
  assert.ok(kept.includes('95007') && kept.includes('me'));
  assert.ok(!kept.includes('p1') && !kept.includes('p6'), 'the oldest went');
  assert.ok(kept.includes('p7'));
});

test('the app\'s state not being open: it says so, does nothing, and starts when it is', async () => {
  const run = load({ appOptions: { available: false } });
  await sleep(100);
  assert.equal(run.live.state, '正在等应用开放桌宠的位置…');
  assert.deepEqual(run.app.moves, []);
  run.app.status = { applied: [], missing: ['pet'] };
  await sleep(60);
  assert.equal(run.live.state, '应用的这个版本没有开放桌宠的位置，无法使用');
  run.app.status = null;
  run.app.available = true;
  assert.ok(await until(() => run.stored()), 'it takes the place once it is open');
  assert.deepEqual(run.warnings, []);
});

test('a loader that has no app state says so, and nothing is started', async () => {
  const run = load({ noApp: true });
  await sleep(60);
  assert.equal(run.live.state, '加载器版本太旧，请先更新加载器');
});

test('switched off, nothing is left running: no more checks, no more moves, no listening', async () => {
  const run = load();
  await sleep(60);
  run.app.dragPet(2025, 861);
  await sleep(200);
  run.dispose();
  assert.equal((run.listeners.get('storage') ?? []).length, 0);
  run.app.bounds.maxLeft = 1000;
  run.app.push(0, 0);
  await sleep(200);
  assert.deepEqual(run.app.moves, []);
});

test('what it did is kept as a short trail with the places, to say why a place is what it is', async () => {
  const run = load({ prepare: withFriends({ 95007: [1239, 1181] }) });
  await sleep(60);
  run.app.dragMember(95007, 700, 700);
  await sleep(200);
  const trail = run.trail().join('\n');
  assert.match(trail, /拖了 95007/);
  assert.match(trail, /记下 95007：700,700/);
  for (let i = 0; i < 60; i += 1) { run.app.dragMember(95007, 700 + i, 700); await sleep(1); }
  assert.ok(run.trail().length <= 40);
});

test('the panel half is one button that asks for the places now, and takes its request away when it stops', () => {
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
