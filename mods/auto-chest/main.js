// Auto chest: opens the pet's chests when they are ready, the way a person does: by pressing the chest.
// What the MOD page shows is in package.json.
//
// It works for as long as the mod is on: the master switch on the MOD page is the switch. The mod is off
// until the person turns it on (defaultEnabled is false in package.json), and turning it off, or reloading
// it, stops it at once (see onDispose below).
//
// How the app does it (read from the 1.0.2 main-window bundle): each side of the pet has a chest. While it
// is not ready the app shows a countdown there; when it is ready it shows `button.reward-btn` inside
// `.reward-anchor--left` / `.reward-anchor--right`. Pressing it asks the server to open the chest, with the
// click count the app has, and the server decides what it costs and what it gives. The app is busy while
// it goes on (the button is `disabled`, `aria-busy`, or `reward-btn--loading`), and afterwards the button is
// gone, replaced by the next countdown. If the click count is not enough the app says so in a toast and the
// button stays.
//
// While a chest is not ready the app shows its countdown (`.reward-countdown`, with the time left as its
// aria-label, "29:07"): that is what the state line on the MOD page tells, so that waiting looks like waiting.
//
// So this only ever presses the button the app itself shows, only when the app is not busy with it, and it
// does not press it again at once if that did nothing. It opens nothing the person could not open.
//
// Runs in the main window only (see "modkit.windows" in package.json): that is where the chests are.

const SIDES = [['left', '左'], ['right', '右']];
const POLL_MS = 250;              // how often it looks while the app is opening a chest
const SETTLE_MS = 30_000;         // the longest it waits for the app to be done with one
const NOTHING_HAPPENED_MS = 2000; // a press the app does not even start on has been ignored
const RETRY_MS = 60_000;          // after a chest that would not open, how long before that side is tried again
const LOGIN_WAIT_MS = 5000;

let opened = 0;           // chests opened since this mod loaded
let timer = null;
let alive = true;         // false once this copy has been stopped
const holdUntil = { left: 0, right: 0 };

const sleep = ms => new Promise(resolve => { timer = setTimeout(resolve, ms); });
const loggedIn = () => !!localStorage.getItem('wuwatappo-login-cuid');
const buttonOf = side => document.querySelector(`.reward-anchor--${side} button.reward-btn`);
const countdownOf = side => document.querySelector(`.reward-anchor--${side} .reward-countdown`)?.getAttribute('aria-label') ?? null;
const busy = button => button.disabled || button.getAttribute('aria-busy') === 'true' || button.classList.contains('reward-btn--loading');
const showOpened = () => mod.live('opened', `${opened} 个`);

// Press the chest on one side, and say what came of it: 'none' (no button, or the app is busy),
// 'opened' (the app took it and the button is gone), or 'refused' (it is still there and idle: not enough
// clicks, or the server said no).
async function press(side) {
  const button = buttonOf(side);
  if (!button || busy(button)) return 'none';

  button.click();
  const pressedAt = Date.now();
  let sawBusy = false;

  while (alive && Date.now() - pressedAt < SETTLE_MS) {
    await sleep(POLL_MS);
    const now = buttonOf(side);
    if (!now) return 'opened';
    if (busy(now)) {
      sawBusy = true;
    } else if (sawBusy || Date.now() - pressedAt >= NOTHING_HAPPENED_MS) {
      return 'refused';
    }
  }
  return alive ? 'refused' : 'none';
}

// What the state says while there is nothing to open: when the next one can be, if the app shows it.
function waitingText() {
  const left = SIDES.filter(([side]) => mod.config.get(side)).map(([side, name]) => [name, countdownOf(side)]).filter(([, time]) => time);
  return left.length ? `下一个箱子：${left.map(([name, time]) => `${name} ${time}`).join('，')}` : '等箱子可以开';
}

async function run() {
  while (alive) {
    if (!loggedIn()) {
      mod.live('state', '等待登录');
      await sleep(LOGIN_WAIT_MS);
      continue;
    }

    let held = null;
    let did = false;
    for (const [side, name] of SIDES) {
      if (!alive || !mod.config.get(side)) continue;
      if (Date.now() < holdUntil[side]) {
        held = name;
        continue;
      }
      const result = await press(side);
      if (!alive) return;
      if (result === 'opened') {
        opened += 1;
        did = true;
        mod.log(`开了${name}边的箱子`);
        showOpened();
      } else if (result === 'refused') {
        holdUntil[side] = Date.now() + RETRY_MS;
        held = name;
        mod.warn(`${name}边的箱子没有开成（点击数可能不够），${RETRY_MS / 1000} 秒后再试`);
      }
    }

    mod.live('state', held ? `${held}边的箱子没开成，稍后再试` : did ? '刚开了一个箱子' : waitingText());
    await sleep(mod.config.get('interval') * 1000);
  }
}

mod.onDispose(() => {
  alive = false;
  clearTimeout(timer);
});

run();
