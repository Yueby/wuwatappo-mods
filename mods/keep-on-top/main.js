// Keep on top: puts the pets' window above the others again, every so often.
//
// The window is made to stay above the others (always on top), and the app trusts that: it asks for it once and takes the
// flag as the fact. Windows, though, can leave a window that has the flag below ordinary ones (seen on the real app: the flag
// on, the app saying "always on top: true", and the window in the order of windows below a maximized browser, a chat
// window and two folders, so that the pets were hidden behind them until the tray menu was opened). The app does not ask
// again while the flag is on (turning it on when it is on changes nothing), so the plugin turns it off and on, which puts the
// window at the top of the ones that stay above.
//
// It does that when it is not in the way: not in game mode (the app hides itself then, and is not to be put above a game), not
// while the pet is being dragged, and not while the window is hidden. The window is never left without the flag: what is
// turned off is turned on again whatever happens in between, and when the plugin stops while it is off.

const SECOND_MS = 1000;
const SETTINGS_KEY = 'wuwatappo-settings';        // the app's own settings, in localStorage: { gameMode, ... }
const LABEL = 'main';

const seconds = () => {
  const value = Number(mod.config.get('interval'));
  return Number.isFinite(value) ? Math.min(120, Math.max(5, value)) : 15;
};

const inGameMode = () => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY))?.gameMode === true;
  } catch {
    return false;
  }
};

const clock = () => new Date().toTimeString().slice(0, 8);

let busy = false;
let lowered = false;              // the flag is off at this moment: it has to be put back
let count = 0;
let failure = '';
let timer = null;

const say = text => mod.live('state', text);
const topmost = value => mod.invoke('plugin:window|set_always_on_top', { label: LABEL, value });

async function raise() {
  if (busy) return;
  busy = true;
  try {
    if (inGameMode()) return say('游戏模式中，未置顶');
    if (document.querySelector('.pet-dock--dragging')) return;
    if ((await mod.invoke('plugin:window|is_visible', { label: LABEL })) === false) return say('窗口已隐藏，未置顶');

    await topmost(false);
    lowered = true;
    await topmost(true);
    lowered = false;
    count += 1;
    failure = '';
    say(`已置顶 ${count} 次，最近一次 ${clock()}`);
  } catch (err) {
    const text = String(err?.message ?? err).slice(0, 80);
    if (text !== failure) mod.warn(`置顶失败：${text}`);       // said once, not at every try
    failure = text;
    say(`置顶失败：${text}`);
  } finally {
    if (lowered) {
      // the flag must not stay off: another try, which is the one that matters
      try {
        await topmost(true);
        lowered = false;
      } catch { /* the next round tries again */ }
    }
    busy = false;
  }
}

function start() {
  clearInterval(timer);
  timer = setInterval(raise, seconds() * SECOND_MS);
}

start();
say('运行中');
mod.config.onChange('interval', start);

mod.onDispose(() => {
  clearInterval(timer);
  if (lowered) topmost(true).catch(() => {});
});
