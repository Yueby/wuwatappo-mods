// Auto click: raises the click count by sending the app the event its global mouse hook sends.
// What the MOD page shows is in package.json.
//
// It clicks for as long as the mod is on: the master switch on the MOD page is the switch. The mod is
// off until the person turns it on (defaultEnabled is false in package.json), and turning it off, or
// reloading it, stops the loop at once (see onDispose below).
//
// How the app handles events (read from the 1.0.2 main-window bundle):
//   * `global-clap-mouse` (and `gamepad-button-press`): one event is one click. The handler
//     counts it and plays the pet's paw animation, alternating left and right. While the person is in a
//     room the app also tells the room about the click, as it does for a real one (the members see
//     the paw), at the rate set here. No payload is read, no matching release is expected, no
//     duration is measured.
//   * `key-press` / `key-release` are different: the paw goes down on press and is put back
//     at once on release, and the click is only counted on the release. A press and release
//     sent together therefore count but show no animation, and a press without its release
//     makes the app ignore that key from then on. That is why this does not use them.
//
// Runs in the main window only (see "modkit.windows" in package.json): the event is handled there,
// and a timer in every window would send it seven times per tick.

const WAIT_FOR_LOGIN_MS = 2000;

let sent = 0;            // clicks sent since this mod loaded
let timer = null;
let alive = true;        // false once this copy has been stopped

const sleep = ms => new Promise(resolve => { timer = setTimeout(resolve, ms); });
const click = () => mod.invoke('plugin:event|emit', { event: 'global-clap-mouse' });
const loggedIn = () => !!localStorage.getItem('wuwatappo-login-cuid');
const showSent = () => mod.live('sent', `${sent} 次`);

async function loop() {
  let waiting = false;

  while (alive) {
    if (!loggedIn()) {
      // Nobody to click for. Wait for a login rather than stopping: the switch is still on.
      if (!waiting) mod.live('state', '等待登录');
      waiting = true;
      await sleep(WAIT_FOR_LOGIN_MS);
      continue;
    }
    if (waiting || sent === 0) mod.live('state', '运行中');
    waiting = false;

    const started = Date.now();
    try {
      await click();
      if (!alive) return;                                 // switched off while it was on its way: nothing more is shown
      sent += 1;
    } catch (err) {
      if (!alive) return;
      mod.warn('stopped:', err.message ?? err);
      mod.live('state', `已停止：${err.message ?? err}`);
      showSent();
      return;                                             // switch it off and on again to start over
    }
    if (sent <= 10 || sent % 10 === 0) showSent();        // the first ones one by one, then every tenth: no message per click

    // The interval is from one click to the next, so the time spent sending counts.
    const rest = mod.config.get('interval') - (Date.now() - started);
    if (rest > 0 && alive) await sleep(rest);
  }
}

// Switching the mod off or reloading it ends the loop. The figures on the page are cleared by the
// framework with it.
mod.onDispose(() => {
  alive = false;
  clearTimeout(timer);
});

loop();
