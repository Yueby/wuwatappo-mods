// Pet position: remembers where the person last put the pets, the person's own and every other player's in the room,
// and puts a pet back when something else has moved it. What the MOD page shows is in package.json.
//
// It sets the places directly, through what the loader opens of the app's own state (`mod.app`, which this plugin
// asks for with the "app-internals" permission): the person's own pet and each player's pet have a place the app
// draws them from, and setting it moves the pet exactly as if it had been dragged there. Nothing is moved with the
// mouse, so nothing here depends on whether the real mouse is moving, and nothing is clicked.
//
// What the app does that makes this needed (read from the 1.0.2 and 1.0.3 main-window scripts):
//   * The person's own pet: when the person drags it, the app saves the place 380 ms later (as ratios, under
//     PLACEMENT_KEY in localStorage), and reads that key once, when it starts. It also saves the place after it
//     has moved the pet itself (the room, the taskbar or the window changing what is free pushes the pet back
//     inside what is free), and that is what loses the person's place: the next start begins from the pushed one.
//   * The other players' pets are put in the next free slot when the player comes in, and their places are never
//     saved: every start, and every time the person enters a room, they are in slots again.
//
// So this does two things. It keeps the key the app starts from as the person left it (it puts the remembered key
// back when the app has saved another one, except right after the person let go of the mouse). And it puts every pet whose
// place the person set by dragging it back there when it is somewhere else, and waits longer after each try that
// did not hold (the room may not leave that place free, and the app then puts the pet back; this does not fight it).
//
// What the person did is told by the app itself (`onDragged`), not guessed from the mouse.
// It only ever moves pets on this screen. It does not read or send anything of the account.

const PLACEMENT_KEY = 'wuwatappo-main-pet-placement-v1';
const SETTINGS_KEY = 'wuwatappo-settings';         // has `position` (a corner) and `petScale`: changing either is the person's choice
const STORE = 'modkit-pet-position';               // what is remembered: { v: 2, layout, placement, pets: { me, <player id>: { left, top, at } } }
const NOW_KEY = 'modkit-pet-position-now';         // written by panel.js: "take the places the pets are at now"
const TRAIL_KEY = 'modkit-pet-position-trail';     // the last things it did, and why
const ME = 'me';
const MAX_PETS = 60;                               // the places of this many pets are kept: the ones set longest ago go first

const CHECK_MS = 1000;            // how often it looks where the pets are
const START_WAIT_MS = 1500;       // after it starts: the app is still arranging things
const SETTLE_MS = 900;            // after the person lets go of a pet: the app puts it down and saves (380 ms after)
const VERIFY_MS = 1500;           // after it set a place: how long before it looks whether the app kept it
const RETRY_MS = [3000, 10_000, 60_000, 300_000];  // waits after tries that did not hold
const QUIET_MS = 1500;            // not while the person holds a mouse button, and this long after
const HEAL_QUIET_MS = 3000;       // the key the app keeps is put right only this long after the person let go of the mouse
const NEW_PLACE_MS = 6000;        // after the app's settings moved the pet: when its new place is taken
const TOLERANCE_PX = 2;
const NOTICE_MS = 10_000;         // how long what a try came to stays as the state
const TRAIL_LINES = 40;

let alive = true;
let remembered = null;            // { v: 2, layout: { vw, vh, scale }, placement, pets: { [id]: { left, top, at } } }
let pressed = false;              // the person is holding a mouse button
let lastRelease = 0;
let lastUserDrag = 0;             // the last time the person let go of a pet they had dragged
let settingsSeen = null;
let takeMeAt = 0;                 // when set: the person's own place is taken from where the pet is, once it is that time
const tries = new Map();          // pet id -> { attempts, nextTryAt }
const trailLines = [];
let startedAt = 0;
let noticeText = '';
let noticeUntil = 0;
let checkTimer = null;
const timers = new Set();
let checking = false;

const now = () => Date.now();

// What it did and why, the last lines, kept with the places: when a place is not what the person set, this says
// which drag or setting it was taken from.
function trail(text) {
  trailLines.push(`${new Date().toTimeString().slice(0, 8)} ${text}`);
  if (trailLines.length > TRAIL_LINES) trailLines.shift();
  try {
    localStorage.setItem(TRAIL_KEY, JSON.stringify(trailLines));
  } catch {
    // not kept
  }
}

// --- where the pets are -------------------------------------------------------------------------------------

function petScale() {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale'));
  return Number.isFinite(value) ? value : 0;
}

const layoutNow = () => ({ vw: window.innerWidth, vh: window.innerHeight, scale: petScale() });
const sameLayout = (a, b) => !!a && !!b && a.vw === b.vw && a.vh === b.vh && a.scale === b.scale;
const near = (dx, dy) => Math.abs(dx) <= TOLERANCE_PX && Math.abs(dy) <= TOLERANCE_PX;
const wantsOthers = () => mod.config.get('others') !== false;

// A player's pet that the app has put in the room (the slot it comes in at); before that its place is not one.
const positioned = id => document.querySelector(`[data-room-cat-id="${id}"]`)?.dataset?.roomCatPositioned === 'true';

// Every pet that has a place: the person's own, and each other player's that is in the room.
function readPets() {
  const pets = new Map();
  const own = mod.app.pet.position();
  if (own) pets.set(ME, { id: ME, ...own });
  for (const member of mod.app.members.list()) {
    const id = String(member.id);
    if (member.draggable && id !== ME && positioned(id)) pets.set(id, { id, left: member.left, top: member.top });
  }
  return pets;
}

const considered = pets => [...pets.values()].filter(pet => pet.id === ME || wantsOthers());
const isOut = pet => !!remembered?.pets[pet.id] && !near(remembered.pets[pet.id].left - pet.left, remembered.pets[pet.id].top - pet.top);

// --- what is kept -------------------------------------------------------------------------------------------

const placementNow = () => localStorage.getItem(PLACEMENT_KEY);

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
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
    if (remembered) localStorage.setItem(STORE, JSON.stringify(remembered));
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
  trail(`记下 ${pet.id}：${Math.round(pet.left)},${Math.round(pet.top)}`);
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

// --- the state line ---------------------------------------------------------------------------------------

// What is going on now; what a try came to is said for a while, and not wiped by the next look.
function report(text) {
  mod.live('state', now() < noticeUntil ? noticeText : text);
}
function notify(text) {
  noticeText = text;
  noticeUntil = now() + NOTICE_MS;
  mod.live('state', text);
}

// --- what the person does -----------------------------------------------------------------------------------

// The person let go of a pet they dragged (the app says so): its place is taken once the app has put it down.
function dragged(id) {
  lastUserDrag = now();
  trail(`拖了 ${id}`);
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (!alive || !mod.app.available()) return;
    const pet = readPets().get(id);
    if (pet && (id === ME || wantsOthers())) {
      remember(pet);
      report('位置已记住');
    }
  }, SETTLE_MS);
  timers.add(timer);
}

// --- putting them back ------------------------------------------------------------------------------------

function setPlace(pet) {
  const goal = remembered.pets[pet.id];
  return pet.id === ME ? mod.app.pet.move(goal.left, goal.top) : mod.app.members.place(pet.id, goal.left, goal.top);
}

function putBack(pet) {
  const state = tries.get(pet.id) ?? { attempts: 0, nextTryAt: 0 };
  if (now() < state.nextTryAt) return;
  state.attempts += 1;
  state.nextTryAt = now() + (state.attempts === 1 ? VERIFY_MS : RETRY_MS[Math.min(state.attempts - 2, RETRY_MS.length - 1)]);
  tries.set(pet.id, state);
  const goal = remembered.pets[pet.id];
  trail(`放回 ${pet.id}：从 ${Math.round(pet.left)},${Math.round(pet.top)} 到 ${Math.round(goal.left)},${Math.round(goal.top)}（第 ${state.attempts} 次）`);
  if (!setPlace(pet)) {
    notify('有桌宠现在放不回去（应用不让动它），稍后再试');
    return;
  }
  if (state.attempts === 1) notify(pet.id === ME ? '已把桌宠放回记住的位置' : '已把玩家的桌宠放回记住的位置');
  else notify(pet.id === ME ? '桌宠没能留在记住的位置（那里可能被占着），稍后再试' : '玩家的桌宠没能留在记住的位置（那里可能被占着），稍后再试');
}

function noticeSettings() {
  let next = null;
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    next = { position: parsed?.position, petScale: parsed?.petScale };
  } catch {
    return;
  }
  const changed = settingsSeen && (settingsSeen.position !== next.position || settingsSeen.petScale !== next.petScale);
  settingsSeen = next;
  if (!changed) return;
  // Where the pet goes, or how big it is, is the person's choice in the app's settings, and the pet is somewhere else
  // because of it: the old place is let go, and the new one is taken once the app has put it there. (A different
  // size is a different layout, so the places of the other players' pets go with it.)
  trail(`应用设置里桌宠的角落或大小变了：${JSON.stringify(next)}`);
  forget(ME);
  takeMeAt = now() + NEW_PLACE_MS;
}

function check() {
  if (!alive || checking) return;
  checking = true;
  try {
    if (!mod.app.available()) {
      report(mod.app.status() ? '应用的这个版本没有开放桌宠的位置，无法使用' : '正在等应用开放桌宠的位置…');
      return;
    }
    noticeSettings();
    const pets = readPets();
    if (!pets.has(ME)) return;
    if (now() - startedAt < START_WAIT_MS) return;
    if (!remembered || (!remembered.pets[ME] && sameLayout(remembered.layout, layoutNow()))) {
      if (now() < takeMeAt) {
        report('桌宠的位置刚改过，稍后记下新的位置');
        return;
      }
      remember(pets.get(ME));                                // the first time: the place it is at
      report('桌宠在记住的位置');
      return;
    }
    if (!sameLayout(remembered.layout, layoutNow())) {
      report('屏幕或桌宠大小变了，之前记的位置不再用');
      return;
    }
    // The key the app starts from stays the person's: the app has saved another one when it pushed the pet itself.
    // Not right after the person let go of the mouse: the key the app saved for a drag is the new place, and is not
    // to be undone before it is taken (the app saves 380 ms after the drag and says so 20 ms after that).
    if (remembered.placement && placementNow() !== remembered.placement && !pressed && now() - lastRelease > HEAL_QUIET_MS) {
      localStorage.setItem(PLACEMENT_KEY, remembered.placement);
      trail('应用自己存了别的位置，已改回亲手拖好的位置');
    }
    const out = considered(pets).filter(isOut);
    for (const id of [...tries.keys()]) if (!out.some(pet => pet.id === id)) tries.delete(id);          // back in place by itself, or gone
    if (!out.length) {
      report('桌宠在记住的位置');
      return;
    }
    if (!mod.config.get('restore')) {
      report('桌宠不在记住的位置（已设为不自动放回）');
      return;
    }
    if (pressed || now() - lastRelease < QUIET_MS || now() - lastUserDrag < QUIET_MS) {
      report('桌宠不在记住的位置，等鼠标松开再放回去');
      return;
    }
    for (const pet of out) putBack(pet);
  } finally {
    checking = false;
  }
}

// --- the panel asks for "take the places the pets are at now" -----------------------------------------------

const onStorage = event => {
  if (!alive || !mod.app.available()) return;
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
  for (const timer of timers) clearTimeout(timer);
  window.removeEventListener('storage', onStorage);
});

if (!mod.app) {
  mod.live('state', '加载器版本太旧，请先更新加载器');
} else {
  mod.onEvent('mouse-button', event => {
    const { button, action } = event?.payload ?? {};
    if (button !== 'left') return;
    if (action === 'press') pressed = true;
    else if (action === 'release') {
      pressed = false;
      lastRelease = now();
    }
  });
  mod.app.pet.onDragged(() => dragged(ME));
  mod.app.members.onDragged(id => dragged(String(id)));
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    settingsSeen = { position: parsed?.position, petScale: parsed?.petScale };
  } catch {
    settingsSeen = null;
  }
  remembered = load();
  startedAt = now();
  showRemembered();
  report('正在等应用开放桌宠的位置…');
  checkTimer = setInterval(check, CHECK_MS);
  check();
}
