// Pet position: remembers where the person last put the pet, and puts it back when something else has moved it.
// What the MOD page shows is in package.json.
//
// How the app does it (read from the 1.0.2 main-window bundle):
//   * The pet is `.pet-dock`, and its place is the dock's left and top in pixels: the element's style is
//     `inset: <top>px auto auto <left>px`. The window is the whole screen, so these are screen positions.
//   * When the person drags it, the app saves the place 380 ms after the drag ends, as ratios and "at the edge"
//     flags in localStorage under PLACEMENT_KEY. It reads that key once, when it starts, and puts the pet there.
//   * The app also saves the place after it has moved the pet itself: when the room, the taskbar or the window
//     changes what is free, it pushes the pet back inside what is free and saves where it ended up. That is
//     what loses the person's place: the next start begins from the pushed place, and nothing brings it back.
//   * The pet is dragged by the native mouse hook, not by the page: the app is sent `mouse-move` {x, y} (screen
//     pixels) and `mouse-button` {button, action} events, and takes the drag from those. The page's own x, y are
//     (native - the window's inner position) / the window's scale.
//
// The app takes the pointer's place from those same events, so a real mouse moving at the same time would be mixed
// with the ones it sends: it does not start while the mouse is moving, and lets go at once if the mouse starts
// moving while it drags. (Its own events come back to it, and are told from the person's by what it sent.)
//
// So this does two things. It lets through the app's saving only for a drag the person made (and for a change
// in the app's own settings of where the pet goes), so the place the app starts from is the one the person
// chose. And when the pet is somewhere else than where it was left, it drags it back the way the native hook
// would: the same events, slowly, with a check after, and waiting longer after each try that did not get it there
// (the room may not leave that place free; the app then pushes it again, and this does not fight it).
//
// It only ever moves the pet. It does not read or send anything of the account.

const PLACEMENT_KEY = 'wuwatappo-main-pet-placement-v1';
const SETTINGS_KEY = 'wuwatappo-settings';         // has `position` (a corner) and `petScale`: changing either is the person's choice
const STORE = 'modkit-pet-position';               // what is remembered: { left, top, vw, vh, scale, placement }
const NOW_KEY = 'modkit-pet-position-now';         // written by panel.js: "take the place it is at now"

const CHECK_MS = 2000;            // how often it looks where the pet is
const STARTUP_WAIT_MS = 6000;     // after it starts, before it moves the pet: the app may still be getting itself in order
const QUIET_MS = 8000;            // the person must not have touched the mouse for this long before the pet is moved
const MOVE_QUIET_MS = 1500;       // nor have moved it for this long
const SENT_MS = 3000;             // how long what it sent is remembered, to tell its own events from the mouse's
const SETTLE_MS = 1200;           // after a drag ends: the app animates it into place and saves 380 ms after that
const ACCEPT_MS = 2500;           // the app's own saving is let through for this long after the person touched the mouse
const SETTINGS_ACCEPT_MS = 6000;  // and after the person changed where the pet goes in the app's settings
const TOLERANCE_PX = 2;
const RETRY_MS = [5000, 15000, 60000, 300000];     // waits after tries that did not bring it back
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
let remembered = null;            // { left, top, vw, vh, scale, placement }
let acceptUntil = 0;
let lastTouch = 0;                // the last time the person pressed or released a mouse button
let pressed = false;              // the person is holding a button
let pressDock = null;             // where the pet was when the person pressed
let emulating = false;            // it is dragging the pet itself
let ignoreUntil = 0;
let lastMove = 0;                 // the last time the mouse moved that was not it
let interrupted = false;          // the mouse moved while it was dragging
const sentMoves = new Map();      // "x,y" -> when it sent a move there
let attempts = 0;
let nextTryAt = 0;
let blockedOnce = false;
let settingsSeen = null;
let geometry = null;              // { x, y, scale, at }
let settleTimer = null;
let checkTimer = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Date.now();

// --- where the pet is ---------------------------------------------------------------------------------------

function petScale() {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale'));
  return Number.isFinite(value) ? value : 0;
}

function readDock() {
  const dock = document.querySelector('.pet-dock');
  const content = document.querySelector('.pet-dock-content');
  if (!dock || !content) return null;
  const found = /inset:\s*(-?[\d.]+)px auto auto (-?[\d.]+)px/.exec(dock.getAttribute('style') ?? '');
  if (!found) return null;
  const box = content.getBoundingClientRect();
  return {
    top: Number(found[1]),
    left: Number(found[2]),
    cx: box.left + box.width / 2,
    cy: box.top + box.height / 2,
    vw: window.innerWidth,
    vh: window.innerHeight,
    scale: petScale(),
  };
}

const sameLayout = (a, b) => a.vw === b.vw && a.vh === b.vh && a.scale === b.scale;
const near = (dx, dy) => Math.abs(dx) <= TOLERANCE_PX && Math.abs(dy) <= TOLERANCE_PX;

// --- what is kept -------------------------------------------------------------------------------------------

const originalSetItem = Storage.prototype.setItem;
const originalGetItem = Storage.prototype.getItem;
const placementNow = () => originalGetItem.call(localStorage, PLACEMENT_KEY);

function load() {
  try {
    const saved = JSON.parse(originalGetItem.call(localStorage, STORE));
    return saved && Number.isFinite(saved.left) && Number.isFinite(saved.top) ? saved : null;
  } catch {
    return null;
  }
}

function showRemembered() {
  mod.live('remembered', remembered ? `左 ${Math.round(remembered.left)}，上 ${Math.round(remembered.top)}` : '还没有');
}

function remember(dock) {
  remembered = { left: dock.left, top: dock.top, vw: dock.vw, vh: dock.vh, scale: dock.scale, placement: placementNow() };
  attempts = 0;
  nextTryAt = 0;
  try {
    originalSetItem.call(localStorage, STORE, JSON.stringify(remembered));
  } catch (err) {
    mod.warn(`没能保存桌宠位置：${err.message}`);
  }
  showRemembered();
}

function forget() {
  remembered = null;
  attempts = 0;
  try {
    localStorage.removeItem(STORE);
  } catch {
    // nothing was kept
  }
  showRemembered();
}

// --- the app's saving ---------------------------------------------------------------------------------------

// The app saves the place after it moved the pet itself as well as after a drag. Only the saving that follows
// something the person did is let through; what the app saves on its own is not, so that the place it starts
// from the next time is the person's.
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
  forget();
  scheduleSettle(Math.max(0, SETTINGS_ACCEPT_MS - 500));
}

// --- what the person does -----------------------------------------------------------------------------------

// Takes the place the pet is at, after the app has had the time to put it down and save it.
function scheduleSettle(ms) {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (!alive || emulating) return;
    const dock = readDock();
    if (!dock) return;
    remember(dock);
    report('位置已记住');
  }, ms);
}

function onMouseButton(event) {
  if (!alive || emulating || now() < ignoreUntil) return;
  const { button, action } = event?.payload ?? {};
  if (button !== 'left') {
    lastTouch = now();
    return;
  }
  lastTouch = now();
  if (action === 'press') {
    pressed = true;
    pressDock = readDock();
  } else if (action === 'release') {
    pressed = false;
    acceptUntil = now() + ACCEPT_MS;
    // A drag moves the pet while the button is down, so it has moved by now; a click, or a pet that something else
    // moves a moment later, has not. Only a drag is a place.
    const dock = readDock();
    if (pressDock && dock && (Math.abs(dock.left - pressDock.left) > TOLERANCE_PX || Math.abs(dock.top - pressDock.top) > TOLERANCE_PX)) scheduleSettle(SETTLE_MS);
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

// --- bringing it back ---------------------------------------------------------------------------------------

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
async function dragBy(dock, dx, dy) {
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
    await emit('mouse-move', toNative(dock.cx, dock.cy));
    await sleep(GRAB_WAIT_MS);
    await emit('mouse-button', { button: 'left', action: 'press' });
    await sleep(PRESS_WAIT_MS);
    for (let step = 1; step <= STEPS && alive && !interrupted; step += 1) {
      await emit('mouse-move', toNative(dock.cx + (dx * step) / STEPS, dock.cy + (dy * step) / STEPS));
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

async function bringBack(dock) {
  const dx = remembered.left - dock.left;
  const dy = remembered.top - dock.top;
  const over = document.elementFromPoint(dock.cx, dock.cy)?.closest?.('.pet-dock-content');
  if (!over) {
    report('桌宠被挤到别处，现在点不到它，稍后再拖回去');
    nextTryAt = now() + RETRY_MS[0];
    return;
  }
  report('正在把桌宠拖回记住的位置…');
  try {
    await dragBy(dock, dx, dy);
  } catch (err) {
    mod.warn(`拖回桌宠没有成功：${err.message ?? err}`);
  }
  await sleep(VERIFY_MS);
  if (!alive) return;
  if (interrupted) {
    notify('鼠标在动，稍后再把桌宠拖回去');
    nextTryAt = now() + MOVE_QUIET_MS * 2;
    return;
  }
  const after = readDock();
  if (after && near(remembered.left - after.left, remembered.top - after.top)) {
    attempts = 0;
    // The app saved where the pet ended up after the drag, and that was held back like any saving of its own. Now that
    // it is where it should be, what the app keeps is what it kept when the place was remembered.
    if (remembered.placement) originalSetItem.call(localStorage, PLACEMENT_KEY, remembered.placement);
    notify('已拖回记住的位置');
    return;
  }
  attempts += 1;
  nextTryAt = now() + RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)];
  notify('桌宠没能回到记住的位置（那里可能被占着），稍后再试');
}

let checking = false;
async function check() {
  if (!alive || checking || emulating) return;
  checking = true;
  try {
    const dock = readDock();
    if (!dock) return;
    if (!remembered) {
      report('还没有记住位置：把桌宠拖到想要的位置就会记住');
      return;
    }
    if (!sameLayout(dock, remembered)) {
      report('屏幕或桌宠大小变了，之前记的位置不再用');
      return;
    }
    if (near(remembered.left - dock.left, remembered.top - dock.top)) {
      attempts = 0;
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
    if (now() < nextTryAt) return;                           // the last try's words stay
    await bringBack(dock);
  } finally {
    checking = false;
  }
}

// --- the panel asks for "take the place it is at now" -------------------------------------------------------

const onStorage = event => {
  if (!alive) return;
  if (event.key === NOW_KEY && event.newValue) {
    const dock = readDock();
    if (dock) {
      remember(dock);
      report('已把现在的位置记下来');
    }
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
nextTryAt = now() + STARTUP_WAIT_MS;
showRemembered();
report('正在看桌宠的位置…');
checkTimer = setInterval(check, CHECK_MS);

// Started while the app is running: if what the app saved is not what was remembered, put what was remembered
// back, so that the next start is right even if the pet cannot be moved now.
{
  const dock = readDock();
  if (remembered && dock && sameLayout(dock, remembered) && remembered.placement && placementNow() !== remembered.placement) {
    originalSetItem.call(localStorage, PLACEMENT_KEY, remembered.placement);
  }
  if (!remembered && dock) remember(dock);
}
check();
