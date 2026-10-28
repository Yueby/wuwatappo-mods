// Auto click: raises the click count by sending the app the event its global mouse hook sends.
// Settings and what the MOD page shows are in package.json.
//
// How the app handles events (read from the 1.0.2 main-window bundle):
//   * `global-clap-mouse` (and `gamepad-button-press`): one event is one click. The handler
//     counts it and plays the pet's paw animation, alternating left and right, and nothing
//     else: no payload is read, no matching release is expected, no duration is measured.
//   * `key-press` / `key-release` are different: the paw goes down on press and is put back
//     at once on release, and the click is only counted on the release. A press and release
//     sent together therefore count but show no animation, and a press without its release
//     makes the app ignore that key from then on. That is why this does not use them.
//
// The "running" switch is persist:false in the manifest: whatever the master switch does,
// clicking only ever starts because the user turned it on in this session.
//
// Runs in the main window only (see "modkit.windows" in package.json): the event is handled there,
// and a timer in every window would send it seven times per tick.

let sent = 0;            // clicks sent since this mod loaded
let timer = null;
let alive = true;        // false once this copy has been stopped
let generation = 0;      // one per start of the loop: an earlier loop must not carry on after a restart

const sleep = ms => new Promise(resolve => { timer = setTimeout(resolve, ms); });
const click = () => mod.invoke('plugin:event|emit', { event: 'global-clap-mouse' });
const loggedIn = () => !!localStorage.getItem('wuwatappo-login-cuid');
const showSent = () => mod.live('sent', `${sent} 次`);

async function loop(mine) {
  const wanted = () => alive && mine === generation && mod.config.get('running');

  while (wanted()) {
    const started = Date.now();
    try {
      if (!loggedIn()) throw new Error('未登录');
      await click();
      sent += 1;
    } catch (err) {
      if (mine !== generation) return;                    // already superseded: nothing left to report
      mod.warn('stopped:', err.message ?? err);
      mod.config.set('running', false);                   // wanted() is false from here on
      mod.live('state', `已停止：${err.message ?? err}`);  // after set(): replaces its plain "已停止"
      showSent();
      return;
    }
    if (sent % 10 === 0) showSent();                      // keep the counter moving without a message per click

    // The interval is from one click to the next, so the time spent sending counts.
    const rest = mod.config.get('interval') - (Date.now() - started);
    if (rest > 0 && wanted()) await sleep(rest);
  }
}

mod.config.onChange('running', on => {
  generation += 1;
  clearTimeout(timer);
  if (!on) {
    mod.live('state', '已停止');
    showSent();
    return;
  }
  mod.live('state', '运行中');
  loop(generation);
});

// Switching the mod off or reloading it must stop the loop, or it would keep clicking with
// no switch left to turn off.
mod.onDispose(() => {
  alive = false;
  clearTimeout(timer);
});
