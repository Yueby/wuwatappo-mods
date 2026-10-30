// Pet position: remembers where the person last put the pets, the person's own and every other player's in the room,
// and puts a pet back when something else has moved it. What the MOD page shows is in package.json.
//
// How the app does it (read from the 1.0.2 main-window bundle):
//   * The person's own pet is `.pet-dock`, and its place is the dock's left and top in pixels: the element's style is
//     `inset: <top>px auto auto <left>px`. The window is the whole screen, so these are screen positions.
//   * Each other player in the room is an element `[data-room-cat-id=<the player's id>]`, once it has been put in the
//     room (`data-room-cat-positioned="true"`), and its place is `left: <x>px; top: <y>px` in its style. The app puts
//     a player's pet in the next free slot when the player comes in, and does not save where the pet is: every time
//     the person enters a room, or starts the app, the pets of the others are in slots again.
//   * When the person drags their own pet, the app saves the place 380 ms after the drag ends, as ratios and "at the
//     edge" flags in localStorage under PLACEMENT_KEY. It reads that key once, when it starts, and puts the pet there.
//   * The app also saves the place after it has moved its own pet itself: when the room, the taskbar or the window
//     changes what is free, it pushes the pet back inside what is free and saves where it ended up. That is
//     what loses the person's place: the next start begins from the pushed place, and nothing brings it back.
//   * Every pet is dragged by the native mouse hook, not by the page: the app is sent `mouse-move` {x, y} (screen
//     pixels) and `mouse-button` {button, action} events, and takes the drag from those, picking up the pet under the
//     pointer. The page's own x, y are (native - the window's inner position) / the window's scale. Dragging another
//     player's pet is local: nothing is sent to the room for it.
//
// The app takes the pointer's place from those same events, so a real mouse moving at the same time would be mixed
// with the ones it sends: it does not start while the mouse is moving, and lets go at once if the mouse starts
// moving while it drags. (Its own events come back to it, and are told from the person's by what it sent.)
//
// So this does two things. It lets through the app's saving of the person's own pet only for a drag the person made
// (and for a change in the app's own settings of where the pet goes), so the place the app starts from is the one
// the person chose. And for each pet the person has dragged to a place, when it is somewhere else than that (the room
// put a player's pet in a slot, or something pushed it) it drags it back the way the native hook would: the same
// events, slowly, with a check after, one pet at a time, and waiting longer after each try that did not get a pet
// there (the room may not leave that place free; the app then pushes it again, and this does not fight it).
//
// It only ever moves pets on this screen. It does not read or send anything of the account.

const PLACEMENT_KEY = 'wuwatappo-main-pet-placement-v1';
const SETTINGS_KEY = 'wuwatappo-settings';         // has `position` (a corner) and `petScale`: changing either is the person's choice
const STORE = 'modkit-pet-position';               // what is remembered: { v: 2, layout, placement, pets: { me, <player id>: { left, top, at } } }
const NOW_KEY = 'modkit-pet-position-now';         // written by panel.js: "take the places the pets are at now"
const ME = 'me';
const MAX_PETS = 60;                               // the places of this many pets are kept: the ones set longest ago go first

const CHECK_MS = 2000;            // how often it looks where the pets are
const STARTUP_WAIT_MS = 6000;     // after it starts, before it moves a pet: the app may still be getting itself in order
const QUIET_MS = 8000;            // the person must not have touched the mouse for this long before a pet is moved
const MOVE_QUIET_MS = 1500;       // nor have moved it for this long
const SENT_MS = 3000;             // how long what it sent is remembered, to tell its own events from the mouse's
const SETTLE_MS = 1200;           // after a drag ends: the app animates the pet into place and saves 380 ms after that
const ACCEPT_MS = 2500;           // the app's own saving is let through for this long after the person touched the mouse
const SETTINGS_ACCEPT_MS = 6000;  // and after the person changed where the pet goes in the app's settings
const TOLERANCE_PX = 2;
const RETRY_MS = [5000, 15000, 60000, 300000];     // waits after tries that did not bring a pet back
const GEOMETRY_MS = 10_000;       // how long the window's position and scale are kept
const GRAB_WAIT_MS = 120;         // after moving the pointer to the pet, before pressing
const PRESS_WAIT_MS = 150;        // after pressing, before the first move: the app takes the press first
const STEP_MS = 40;
const STEPS = 10;
const RELEASE_WAIT_MS = 120;
const VERIFY_MS = 1000;           // after letting go: the app animates the pet into place
const ECHO_MS = 400;              // the events it sends itself come back to it this late
const NOTICE_MS = 10_000;         // how long what a try came to stays as the state

let alive = true;
let remembered = null;            // { v: 2, layout: { vw, vh, scale }, placement, pets: { [id]: { left, top, at } } }
let acceptUntil = 0;
let lastTouch = 0;                // the last time the person pressed or released a mouse button
let pressed = false;              // the person is holding a button
let pressPets = null;             // where the pets were when the person pressed
let emulating = false;            // it is dragging a pet itself
let ignoreUntil = 0;
let lastMove = 0;                 // the last time the mouse moved that was not it
let interrupted = false;          // the mouse moved while it was dragging
const sentMoves = new Map();      // "x,y" -> when it sent a move there
const tries = new Map();          // pet id -> { attempts, nextTryAt }
let startedAt = 0;
let blockedOnce = false;
let settingsSeen = null;
let geometry = null;              // { x, y, scale, at }
let settleTimer = null;
let settleIds = new Set();        // the pets whose places are taken when the timer runs out
let checkTimer = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Date.now();

// --- where the pets are -------------------------------------------------------------------------------------

function petScale() {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale'));
  return Number.isFinite(value) ? value : 0;
}

const layoutNow = () => ({ vw: window.innerWidth, vh: window.innerHeight, scale: petScale() });
const sameLayout = (a, b) => !!a && !!b && a.vw === b.vw && a.vh === b.vh && a.scale === b.scale;
const near = (dx, dy) => Math.abs(dx) <= TOLERANCE_PX && Math.abs(dy) <= TOLERANCE_PX;
const centreOf = element => {
  const box = element.getBoundingClientRect();
  return { cx: box.left + box.width / 2, cy: box.top + box.height / 2 };
};

// Every pet on the screen that has a place: the person's own, and each other player's that is in the room.
// `left` and `top` are what the app keeps for the pet; `cx` and `cy` are where its body is on the screen now.
function readPets() {
  const pets = new Map();
  const dock = document.querySelector('.pet-dock');
  const content = document.querySelector('.pet-dock-content');
  const own = dock && content ? /inset:\s*(-?[\d.]+)px auto auto (-?[\d.]+)px/.exec(dock.getAttribute('style') ?? '') : null;
  if (own) pets.set(ME, { id: ME, top: Number(own[1]), left: Number(own[2]), ...centreOf(content) });
  for (const element of document.querySelectorAll('[data-room-cat-id]')) {
    if (element.dataset?.roomCatPositioned !== 'true') continue;
    const found = /left:\s*(-?[\d.]+)px;\s*top:\s*(-?[\d.]+)px/.exec(element.getAttribute('style') ?? '');
    const id = String(element.dataset.roomCatId ?? '');
    if (found && id && id !== ME) pets.set(id, { id, left: Number(found[1]), top: Number(found[2]), ...centreOf(element) });
  }
  return pets;
}

const wantsOthers = () => mod.config.get('others') !== false;
const considered = pets => [...pets.values()].filter(pet => pet.id === ME || wantsOthers());
const isOut = pet => !!remembered?.pets[pet.id] && !near(remembered.pets[pet.id].left - pet.left, remembered.pets[pet.id].top - pet.top);

// --- what is kept -------------------------------------------------------------------------------------------

const originalSetItem = Storage.prototype.setItem;
const originalGetItem = Storage.prototype.getItem;
const placementNow = () => originalGetItem.call(localStorage, PLACEMENT_KEY);

function load() {
  try {
    const saved = JSON.parse(originalGetItem.call(localStorage, STORE));
    if (saved?.v === 2 && saved.layout && saved.pets && typeof saved.pets === 'object') return saved;
    // the first version kept the person's own pet only
    if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
      return { v: 2, layout: { vw: saved.vw, vh: saved.vh, scale: saved.scale }, placement: saved.placement ?? null, pets: { [ME]: { left: saved.left, top: saved.top, at: now() } } };
    }
  } catch {
    // nothing kept, or not readable
  }
  return null;
}

function save() {
  try {
    if (remembered) originalSetItem.call(localStorage, STORE, JSON.stringify(remembered));
    else localStorage.removeItem(STORE);
  } catch (err) {
    mod.warn(`没能保存桌宠位置：${err.message}`);
  }
}

function showRemembered() {
  const own = remembered?.pets[ME];
  const others = remembered ? Object.keys(remembered.pets).length - (own ? 1 : 0) : 0;
  const parts = [];
  if (own) parts.push(`左 ${Math.round(own.left)}，上 ${Math.round(own.top)}`);
  if (others) parts.push(`${others} 位玩家的桌宠`);
  mod.live('remembered', parts.length ? parts.join('；') : '还没有');
}

function remember(pet) {
  const layout = layoutNow();
  if (!remembered || !sameLayout(remembered.layout, layout)) {          // another screen or size: the places kept for the old one are not used
    remembered = { v: 2, layout, placement: null, pets: {} };
    tries.clear();
  }
  remembered.pets[pet.id] = { left: pet.left, top: pet.top, at: now() };
  if (pet.id === ME) remembered.placement = placementNow();
  const ids = Object.keys(remembered.pets).filter(id => id !== ME);
  if (ids.length > MAX_PETS) {
    for (const id of ids.sort((a, b) => remembered.pets[a].at - remembered.pets[b].at).slice(0, ids.length - MAX_PETS)) delete remembered.pets[id];
  }
  tries.delete(pet.id);
  save();
  showRemembered();
}

function forget(id) {
  if (!remembered) return;
  delete remembered.pets[id];
  tries.delete(id);
  if (!Object.keys(remembered.pets).length) remembered = null;
  save();
  showRemembered();
}

// --- the app's saving ---------------------------------------------------------------------------------------

// The app saves the place of the person's own pet after it moved the pet itself as well as after a drag. Only the
// saving that follows something the person did is let through; what the app saves on its own is not, so that the
// place it starts from the next time is the person's.
const wrapper = function setItem(key, value) {
  if (alive && this === localStorage) {
    if (key === PLACEMENT_KEY && now() >= acceptUntil) {
      if (!blockedOnce) {
        blockedOnce = true;
        mod.log('应用自己挪动桌宠后要保存新位置，已挡下，保存的仍是亲手拖好的位置');
      }
      return undefined;
    }
    if (key === SETTINGS_KEY) noteSettings(value);
  }
  return originalSetItem.apply(this, arguments);
};
Storage.prototype.setItem = wrapper;

// Where the pet goes, or how big it is, is also set in the app's settings; that is the person's choice and the
// pet will be somewhere else because of it: the old place is forgotten, and the new one is taken once it is there.
// (A different size is a different layout, so the places of the other players' pets go with it.)
function noteSettings(value) {
  let next = null;
  try {
    const parsed = JSON.parse(value);
    next = { position: parsed?.position, petScale: parsed?.petScale };
  } catch {
    return;
  }
  const changed = settingsSeen && (settingsSeen.position !== next.position || settingsSeen.petScale !== next.petScale);
  settingsSeen = next;
  if (!changed) return;
  acceptUntil = now() + SETTINGS_ACCEPT_MS;
  forget(ME);
  scheduleSettle(Math.max(0, SETTINGS_ACCEPT_MS - 500), [ME]);
}

// --- what the person does -----------------------------------------------------------------------------------

// Takes the places of the pets that were dragged, after the app has had the time to put them down and save.
function scheduleSettle(ms, ids) {
  for (const id of ids) settleIds.add(id);
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    const wanted = settleIds;
    settleIds = new Set();
    if (!alive || emulating) return;
    const pets = readPets();
    for (const id of wanted) {
      const pet = pets.get(id);
      if (pet && (id === ME || wantsOthers())) remember(pet);
    }
    report('位置已记住');
  }, ms);
}

// The pets that are somewhere else than they were when the button went down.
function movedSince(before, after) {
  const ids = [];
  for (const [id, pet] of after) {
    const was = before.get(id);
    if (was && !near(pet.cx - was.cx, pet.cy - was.cy)) ids.push(id);
  }
  return ids;
}

function onMouseButton(event) {
  if (!alive || emulating || now() < ignoreUntil) return;
  const { button, action } = event?.payload ?? {};
  lastTouch = now();
  if (button !== 'left') return;
  if (action === 'press') {
    pressed = true;
    pressPets = readPets();
  } else if (action === 'release') {
    pressed = false;
    acceptUntil = now() + ACCEPT_MS;
    // A drag moves the pet while the button is down, so it has moved by now; a click, or a pet that something else
    // moves a moment later, has not. Only a drag is a place, and only of the pets that moved.
    const moved = pressPets ? movedSince(pressPets, readPets()) : [];
    pressPets = null;
    if (moved.length) scheduleSettle(SETTLE_MS, moved);
  }
}

mod.onEvent('mouse-button', onMouseButton);

const spot = point => `${Math.round(point?.x)},${Math.round(point?.y)}`;
function onMouseMove(event) {
  if (!alive) return;
  const sentAt = sentMoves.get(spot(event?.payload));
  if (sentAt !== undefined && now() - sentAt < SENT_MS) return;        // its own, coming back
  lastMove = now();
  if (emulating) interrupted = true;
}
mod.onEvent('mouse-move', onMouseMove);

// --- bringing them back -------------------------------------------------------------------------------------

// The state line says what is going on now; what a try came to is said for a while, and not wiped by the next look.
let noticeText = '';
let noticeUntil = 0;
function report(text) {
  mod.live('state', now() < noticeUntil ? noticeText : text);
}
function notify(text) {
  noticeText = text;
  noticeUntil = now() + NOTICE_MS;
  mod.live('state', text);
}

async function windowGeometry() {
  if (geometry && now() - geometry.at < GEOMETRY_MS) return geometry;
  const [position, scale] = await Promise.all([
    mod.invoke('plugin:window|inner_position', { label: 'main' }),
    mod.invoke('plugin:window|scale_factor', { label: 'main' }),
  ]);
  geometry = { x: Number(position?.x ?? position?.[0] ?? 0), y: Number(position?.y ?? position?.[1] ?? 0), scale: Number(scale) || 1, at: now() };
  return geometry;
}

// The same events the native hook sends for a drag: the pointer to the pet, the button down, the pointer in
// steps, the button up. The button is always let go, whatever happens in between.
async function dragBy(pet, dx, dy) {
  const { x: ix, y: iy, scale } = await windowGeometry();
  const toNative = (cx, cy) => ({ x: Math.round(cx * scale + ix), y: Math.round(cy * scale + iy) });
  const emit = (name, payload) => {
    if (name === 'mouse-move') {
      for (const [key, at] of sentMoves) if (now() - at > SENT_MS) sentMoves.delete(key);
      sentMoves.set(spot(payload), now());
    }
    return mod.invoke('plugin:event|emit', { event: name, payload });
  };
  emulating = true;
  interrupted = false;
  try {
    await emit('mouse-move', toNative(pet.cx, pet.cy));
    await sleep(GRAB_WAIT_MS);
    await emit('mouse-button', { button: 'left', action: 'press' });
    await sleep(PRESS_WAIT_MS);
    for (let step = 1; step <= STEPS && alive && !interrupted; step += 1) {
      await emit('mouse-move', toNative(pet.cx + (dx * step) / STEPS, pet.cy + (dy * step) / STEPS));
      await sleep(STEP_MS);
    }
    await sleep(RELEASE_WAIT_MS);
  } finally {
    try {
      await emit('mouse-button', { button: 'left', action: 'release' });
    } finally {
      emulating = false;
      ignoreUntil = now() + ECHO_MS;
    }
  }
}

// Is the pet there to be picked up: whatever is at its body is the pet itself, and not another pet or a button.
function pickable(pet) {
  const element = document.elementFromPoint(pet.cx, pet.cy);
  if (pet.id === ME) return !!element?.closest?.('.pet-dock-content');
  return String(element?.closest?.('[data-room-cat-id]')?.dataset?.roomCatId ?? '') === pet.id;
}

async function bringBack(pet) {
  const goal = remembered.pets[pet.id];
  const own = pet.id === ME;
  if (!pickable(pet)) {
    report('有桌宠被挤到别处，现在点不到它，稍后再拖回去');
    tries.set(pet.id, { attempts: tries.get(pet.id)?.attempts ?? 0, nextTryAt: now() + RETRY_MS[0] });
    return;
  }
  report(own ? '正在把桌宠拖回记住的位置…' : '正在把玩家的桌宠拖回记住的位置…');
  try {
    await dragBy(pet, goal.left - pet.left, goal.top - pet.top);
  } catch (err) {
    mod.warn(`拖回桌宠没有成功：${err.message ?? err}`);
  }
  await sleep(VERIFY_MS);
  if (!alive) return;
  if (interrupted) {
    notify('鼠标在动，稍后再把桌宠拖回去');
    tries.set(pet.id, { attempts: tries.get(pet.id)?.attempts ?? 0, nextTryAt: now() + MOVE_QUIET_MS * 2 });
    return;
  }
  const after = readPets().get(pet.id);
  if (after && near(goal.left - after.left, goal.top - after.top)) {
    tries.delete(pet.id);
    // The app saved where the person's own pet ended up after the drag, and that was held back like any saving of its
    // own. Now that it is where it should be, what the app keeps is what it kept when the place was remembered.
    if (own && remembered?.placement) originalSetItem.call(localStorage, PLACEMENT_KEY, remembered.placement);
    notify(own ? '已拖回记住的位置' : '已把玩家的桌宠拖回记住的位置');
    return;
  }
  const attempts = (tries.get(pet.id)?.attempts ?? 0) + 1;
  tries.set(pet.id, { attempts, nextTryAt: now() + RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)] });
  notify(own ? '桌宠没能回到记住的位置（那里可能被占着），稍后再试' : '玩家的桌宠没能回到记住的位置（那里可能被占着），稍后再试');
}

let checking = false;
async function check() {
  if (!alive || checking || emulating) return;
  checking = true;
  try {
    const pets = readPets();
    if (!pets.has(ME)) return;
    if (!remembered) {
      report('还没有记住位置：把桌宠拖到想要的位置就会记住');
      return;
    }
    if (!sameLayout(remembered.layout, layoutNow())) {
      report('屏幕或桌宠大小变了，之前记的位置不再用');
      return;
    }
    const out = considered(pets).filter(isOut);
    for (const id of [...tries.keys()]) if (!out.some(pet => pet.id === id)) tries.delete(id);          // back in place by itself, or gone
    if (!out.length) {
      report('桌宠在记住的位置');
      return;
    }
    if (!mod.config.get('restore')) {
      report('桌宠不在记住的位置（已设为不自动拖回）');
      return;
    }
    if (pressed || now() - lastTouch < QUIET_MS || now() - lastMove < MOVE_QUIET_MS) {
      report('桌宠不在记住的位置，等鼠标停下来再拖回去');
      return;
    }
    if (now() - startedAt < STARTUP_WAIT_MS) return;
    // one at a time: the person's own first, then the others in the order of their ids
    const ready = out
      .filter(pet => now() >= (tries.get(pet.id)?.nextTryAt ?? 0))
      .sort((a, b) => (a.id === ME ? -1 : b.id === ME ? 1 : a.id.localeCompare(b.id, 'en', { numeric: true })));
    if (ready.length) await bringBack(ready[0]);                // otherwise the last try's words stay
  } finally {
    checking = false;
  }
}

// --- the panel asks for "take the places the pets are at now" -----------------------------------------------

const onStorage = event => {
  if (!alive) return;
  if (event.key === NOW_KEY && event.newValue) {
    const pets = considered(readPets());
    if (!pets.length) return;
    for (const pet of pets) remember(pet);
    report('已把现在的位置记下来');
  }
};
window.addEventListener('storage', onStorage);

// --- start and stop -----------------------------------------------------------------------------------------

mod.onDispose(() => {
  alive = false;
  clearInterval(checkTimer);
  clearTimeout(settleTimer);
  window.removeEventListener('storage', onStorage);
  if (Storage.prototype.setItem === wrapper) Storage.prototype.setItem = originalSetItem;     // not if somebody has wrapped it since
});

try {
  settingsSeen = (() => {
    const parsed = JSON.parse(originalGetItem.call(localStorage, SETTINGS_KEY));
    return { position: parsed?.position, petScale: parsed?.petScale };
  })();
} catch {
  settingsSeen = null;
}

remembered = load();
startedAt = now();
showRemembered();
report('正在看桌宠的位置…');
checkTimer = setInterval(check, CHECK_MS);

// Started while the app is running: if what the app saved is not what was remembered, put what was remembered
// back, so that the next start is right even if the pet cannot be moved now.
{
  const own = readPets().get(ME);
  if (remembered && own && sameLayout(remembered.layout, layoutNow()) && remembered.placement && placementNow() !== remembered.placement) {
    originalSetItem.call(localStorage, PLACEMENT_KEY, remembered.placement);
  }
  if (own && (!remembered || (sameLayout(remembered.layout, layoutNow()) && !remembered.pets[ME]))) remember(own);        // the places of others only: the person's own is where it is
}
check();
