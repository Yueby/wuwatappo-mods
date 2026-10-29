// mods/auto-chest, run against a stand-in for the app's chest buttons and for `mod`. Nothing here talks to
// the app, so no chest is ever opened: this is how it is tested without touching anyone's account.
//
// The stand-in behaves the way the app's code reads (see the comment at the top of the mod): a ready chest
// is a `button.reward-btn` in `.reward-anchor--left|right`; pressing it makes the app busy for a while
// (disabled, aria-busy); then either the button is gone (opened) or it is back, idle (refused: not enough
// clicks). A disabled button does nothing when pressed.
//
//   node --test tests/auto-chest.test.js

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const folder = path.join(import.meta.dirname, '..', 'mods', 'auto-chest');
const original = await fs.readFile(path.join(folder, 'main.js'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
// Every run is switched off when the tests end, so that one that fails halfway does not leave its loop
// running and the process waiting for it.
const running = [];
after(() => running.forEach(run => run.dispose()));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Waits as the plugin asks for them: what was asked for is kept, and which are still pending. `short`: they are
// made short (5 ms), so that a long wait can be looked at without waiting for it; not short, they are as long as asked.
function makeTimers(short = true) {
  const spy = { delays: [], active: new Set() };
  spy.setTimeout = (fn, ms) => {
    spy.delays.push(ms);
    const id = setTimeout(() => { spy.active.delete(id); fn(); }, short ? Math.min(ms, 5) : ms);
    spy.active.add(id);
    return id;
  };
  spy.clearTimeout = id => { spy.active.delete(id); clearTimeout(id); };
  return spy;
}

function displayedTexts(code, manifest) {
  const lines = code.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  const strings = [...lines.matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)].map(match => match[1] ?? match[2]).filter(text => /[\u4e00-\u9fff]/.test(text));
  const settings = manifest.modkit.settings.flatMap(setting => [setting.title, setting.description, typeof setting.default === 'string' ? setting.default : null]);
  return [manifest.description, manifest.displayName, ...settings, ...strings].filter(Boolean);
}

// The mod's waits are seconds long; a test cannot wait that. The constants are replaced, and each one has to
// have been found, so that renaming one cannot quietly leave a test running at full speed.
const FAST = { POLL_MS: 8, SETTLE_MS: 1500, NOTHING_HAPPENED_MS: 90, RETRY_MS: 400, LOGIN_WAIT_MS: 25 };
let source = original;
for (const [name, value] of Object.entries(FAST)) {
  const pattern = new RegExp(`const ${name} = [\\d_]+;`);
  assert.match(source, pattern, `${name} is in the mod`);
  source = source.replace(pattern, `const ${name} = ${value};`);
}

// One side's chest as the app has it. `outcome`: what the app does when it is done with a press.
function makeChest({ ready = true, busyMs = 40, outcome = 'opens', countdown = '29:07' } = {}) {
  const chest = { present: ready, countdown, busy: false, disabledFor: 0, presses: 0, ignored: 0, outcome, busyMs, aria: 'false' };
  chest.button = {
    get disabled() { return chest.busy; },
    getAttribute: name => (name === 'aria-busy' ? (chest.busy ? 'true' : chest.aria) : null),
    classList: { contains: name => name === 'reward-btn--loading' && chest.loading === true },
    click() {
      if (chest.busy) { chest.ignored += 1; return; }      // a disabled button does nothing
      chest.presses += 1;
      if (chest.outcome === 'ignored') return;              // the app does not even start
      chest.busy = true;
      setTimeout(() => {
        chest.busy = false;
        if (chest.outcome === 'opens') chest.present = false;
      }, chest.busyMs);
    },
  };
  return chest;
}

function load({ left = makeChest({ ready: false }), right = makeChest({ ready: false }), config = {}, loggedIn = true, constants = null, timers = false } = {}) {
  const settings = { left: true, right: true, interval: 0.03, ...config };
  const disposers = [];
  const live = {};
  const logs = [];
  const warnings = [];
  const world = { left, right };
  const login = { in: loggedIn };

  const mod = {
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => warnings.push(a.join(' ')),
    live: (key, value) => { live[key] = value; },
    onDispose: fn => disposers.push(fn),
    config: { get: key => settings[key] },
  };
  const document = {
    querySelector: selector => {
      const found = /^\.reward-anchor--(left|right) (button\.reward-btn|\.reward-countdown)$/.exec(selector);
      assert.ok(found, `it looked for something the app does not have: ${selector}`);
      const chest = world[found[1]];
      if (found[2] === '.reward-countdown') return chest.present ? null : { getAttribute: name => (name === 'aria-label' ? chest.countdown : null) };   // a chest that is not ready has its countdown there
      return chest.present ? chest.button : null;
    },
  };
  const localStorage = { getItem: () => (login.in ? 'cuid' : null) };

  let code = source;
  for (const [name, value] of Object.entries(constants ?? {})) {
    const pattern = new RegExp(`const ${name} = [\\d_]+;`);
    assert.match(code, pattern, `${name} is in the mod`);
    code = code.replace(pattern, `const ${name} = ${value};`);
  }
  const spy = timers ? makeTimers(timers !== 'real') : null;
  new AsyncFunction('mod', 'document', 'localStorage', 'setTimeout', 'clearTimeout', code)(mod, document, localStorage, spy?.setTimeout ?? setTimeout, spy?.clearTimeout ?? clearTimeout);
  const run = { mod, settings, live, logs, warnings, world, login, spy, dispose: () => disposers.forEach(fn => fn()) };
  running.push(run);
  return run;
}

test('it is off until the person turns it on, with the master switch as the switch, and only what a person could do', () => {
  assert.equal(manifest.modkit.defaultEnabled, false, 'opening chests spends clicks on the account: it starts off');
  assert.deepEqual(manifest.modkit.settings.map(s => s.key), ['right', 'left', 'interval', 'state', 'opened']);
  assert.ok(!/invoke|fetch|XMLHttpRequest|chests\/open/.test(original.replace(/\/\/.*$/gm, '')), 'it does not call the server or the app\'s commands itself: it presses the button');
});

test('a chest that is ready is pressed once, and counted when the app has opened it', async () => {
  const run = load({ left: makeChest({ busyMs: 60 }) });
  await sleep(400);
  run.dispose();

  assert.equal(run.world.left.presses, 1);
  assert.equal(run.live.opened, '1 个');
  assert.match(run.logs.join('\n'), /开了下面的箱子/);
});

test('both sides are opened, one after the other', async () => {
  const run = load({ left: makeChest({ busyMs: 50 }), right: makeChest({ busyMs: 50 }) });
  await sleep(500);
  run.dispose();

  assert.deepEqual([run.world.left.presses, run.world.right.presses], [1, 1]);
  assert.equal(run.live.opened, '2 个');
});

test('while the app is busy with a chest it is not pressed again, however long that takes', async () => {
  const run = load({ left: makeChest({ busyMs: 400 }) });
  await sleep(250);                                         // busy, and the mod is looking all the time
  assert.equal(run.world.left.presses, 1);
  assert.equal(run.world.left.ignored, 0, 'not even a press the app would have ignored');
  await sleep(400);
  run.dispose();
  assert.equal(run.world.left.presses, 1);
});

test('a chest whose button is disabled, busy or loading is left alone until it is free', async () => {
  const chest = makeChest();
  chest.busy = true;                                         // the app is busy with something else
  const run = load({ left: chest });
  await sleep(150);
  assert.equal(chest.presses + chest.ignored, 0, 'not pressed while busy');

  chest.busy = false;
  chest.loading = true;                                      // loading
  await sleep(150);
  assert.equal(chest.presses + chest.ignored, 0, 'not pressed while loading');

  chest.loading = false;
  await sleep(250);
  run.dispose();
  assert.equal(chest.presses, 1, 'pressed once it is free');
});

test('a chest the app refuses (it is back, idle) is not pressed again at once, only after a pause, and the other side goes on', async () => {
  const run = load({ left: makeChest({ busyMs: 30, outcome: 'refuses' }), right: makeChest({ busyMs: 30 }) });
  await sleep(250);
  assert.equal(run.world.left.presses, 1, 'once, then it waits');
  assert.equal(run.world.right.presses, 1, 'the other side was not held up by it');
  assert.match(run.live.state, /下面的箱子没开成/);
  assert.match(run.warnings.join('\n'), /下面的箱子没有开成，0\.4 秒后再试/);

  await sleep(600);                                          // past the pause (400 ms here)
  run.dispose();
  assert.ok(run.world.left.presses >= 2, 'it tried again after the pause');
  assert.ok(run.world.left.presses <= 3, `and not in a flurry: ${run.world.left.presses}`);
});

test('a press the app takes no notice of is treated as refused too, so it is not pressed in a loop', async () => {
  const run = load({ left: makeChest({ outcome: 'ignored' }) });
  await sleep(300);
  run.dispose();
  assert.equal(run.world.left.presses, 1);
  assert.match(run.live.state, /没开成/);
});

test('a side that is switched off is never pressed, and one that is switched on again is', async () => {
  const run = load({ left: makeChest({ busyMs: 30 }), right: makeChest({ busyMs: 30 }), config: { right: false } });
  await sleep(300);
  assert.deepEqual([run.world.left.presses, run.world.right.presses], [1, 0]);

  run.settings.right = true;
  await sleep(300);
  run.dispose();
  assert.equal(run.world.right.presses, 1);
});

test('a chest that only becomes ready later is found at the next look', async () => {
  const left = makeChest({ ready: false, busyMs: 30 });
  const run = load({ left });
  await sleep(150);
  assert.equal(left.presses, 0);
  assert.match(run.live.state, /^下一个箱子：上面 29:07，下面 29:07/, 'waiting says for how long, the upper one first');

  left.present = true;
  await sleep(250);
  run.dispose();
  assert.equal(left.presses, 1);
});

test('not logged in: nothing is pressed; once someone logs in it works', async () => {
  const left = makeChest({ busyMs: 30 });
  const run = load({ left, loggedIn: false });
  await sleep(150);
  assert.equal(left.presses, 0);
  assert.equal(run.live.state, '等待登录');

  run.login.in = true;
  await sleep(300);
  run.dispose();
  assert.equal(left.presses, 1);
});

test('switching it off stops it at once, even in the middle of waiting for the app, and nothing is pressed afterwards', async () => {
  const upper = makeChest({ busyMs: 600 });                  // the upper one ("right" in the app) is pressed first
  const run = load({ right: upper, left: makeChest({ busyMs: 30 }) });
  await sleep(100);                                          // pressed the upper one, waiting for the app
  assert.equal(upper.presses, 1);
  run.dispose();

  await sleep(900);
  assert.equal(run.world.left.presses, 0, 'it did not go on to the other chest after being switched off');
  assert.equal(upper.presses, 1);
});

test('while there is nothing to open the state says when the next one can be, from the app\'s own countdown', async () => {
  const left = makeChest({ ready: false, countdown: '29:07' });
  const right = makeChest({ ready: false, countdown: '12:30' });
  const run = load({ left, right });
  await sleep(120);
  assert.equal(run.live.state, '下一个箱子：上面 12:30，下面 29:07');

  run.settings.right = false;                                // a side that is switched off is not waited for
  await sleep(120);
  assert.equal(run.live.state, '下一个箱子：下面 29:07');

  left.countdown = '29:06';                                  // and it follows the app's clock
  await sleep(120);
  assert.equal(run.live.state, '下一个箱子：下面 29:06');
  run.dispose();
});

test('when the app shows no countdown either, the state falls back to plain words', async () => {
  const run = load({ left: makeChest({ ready: false, countdown: null }), right: makeChest({ ready: false, countdown: null }) });
  await sleep(120);
  run.dispose();
  assert.equal(run.live.state, '等箱子可以开');
});

// --- found by the review ------------------------------------------------------------------------------------

test('the waits it really has are the ones in its description: what the tests shorten is pinned here', () => {
  for (const line of ['const POLL_MS = 250;', 'const SETTLE_MS = 30_000;', 'const NOTHING_HAPPENED_MS = 2000;', 'const RETRY_MS = 60_000;', 'const MAX_RETRY_MS = 600_000;', 'const REST_SLICE_MS = 1000;', 'const LOGIN_WAIT_MS = 5000;']) {
    assert.ok(original.includes(line), `${line} is the real value`);
  }
  assert.equal(manifest.modkit.settings.find(s => s.key === 'interval').default, 3);
});

test('a button the app marks aria-busy is left alone, even if it is not disabled', async () => {
  const chest = makeChest();
  chest.aria = 'true';                                       // busy by its own attribute, and enabled
  const run = load({ left: chest });
  await sleep(150);
  assert.equal(chest.presses + chest.ignored, 0, 'not pressed while aria-busy');
  chest.aria = 'false';
  await sleep(250);
  run.dispose();
  assert.equal(chest.presses, 1, 'pressed when it is free');
});

test('switched off, nothing is left waiting: no timer is pending, even in the long waits', async () => {
  const run = load({ timers: 'real' });                       // nothing to open: it is in its wait between looks, as long as it is in earnest
  await sleep(60);
  assert.ok(run.spy.active.size > 0, 'it is waiting');
  run.dispose();
  assert.equal(run.spy.active.size, 0, 'and not after it is off');
});

test('the interval is in seconds, and is read as it goes: a shorter one applies at once, not after the old one', async () => {
  const quick = load({ timers: true, config: { interval: 0.4 } });
  await sleep(80);
  assert.ok(quick.spy.delays.some(ms => ms > 300 && ms <= 400), `0.4 is 400 ms: ${quick.spy.delays.slice(0, 6).join(', ')}`);
  quick.dispose();

  const long = load({ timers: true, config: { interval: 60 } });
  await sleep(80);
  assert.ok(long.spy.delays.every(ms => ms <= 1000), 'a minute is waited in pieces of at most a second');
  assert.ok(long.spy.delays.filter(ms => ms === 1000).length >= 2);

  const run = long;
  run.settings.interval = 0.05;
  const before = run.spy.delays.length;
  await sleep(80);
  run.dispose();
  assert.ok(run.spy.delays.slice(before).some(ms => ms <= 50), 'the new interval is what the next wait is cut to');
});

test('a chest that keeps being refused is tried less and less often, up to a limit, and a chest that opens starts over', async () => {
  const chest = makeChest({ outcome: 'ignored' });
  const run = load({ left: chest, constants: { RETRY_MS: 100, MAX_RETRY_MS: 300, NOTHING_HAPPENED_MS: 40, POLL_MS: 8 } });
  await sleep(1700);
  assert.deepEqual(run.warnings.slice(0, 4).map(w => w.replace(/.*，/, '')), ['0.1 秒后再试', '0.2 秒后再试', '0.3 秒后再试', '0.3 秒后再试']);

  chest.outcome = 'opens';                                    // it works for once
  await sleep(500);
  assert.equal(chest.present, false);
  chest.present = true;
  chest.outcome = 'ignored';
  const warned = run.warnings.length;
  await sleep(700);
  run.dispose();
  assert.equal(run.warnings[warned].replace(/.*，/, ''), '0.1 秒后再试', 'after an opening it starts at the shortest again');
});

test('a chest the app is still busy with after the long wait is not called refused, and is not held', async () => {
  const run = load({ left: makeChest({ busyMs: 2300 }) });   // the tests wait 1.5 s at most for the app
  await sleep(1800);
  assert.equal(run.warnings.length, 0, 'no warning: the app has not said no');
  assert.ok(!/没开成/.test(run.live.state ?? ''));
  await sleep(900);
  run.dispose();
  assert.equal(run.world.left.presses, 1, 'and it was not pressed again while it was busy');
});

test('what it shows has no 我, 咱, 您, 你, 他, 她: labels and statements, like the app\'s own pages', () => {
  for (const text of displayedTexts(original, manifest)) assert.ok(!/[我咱您你她]|(?<!其)他/.test(text), `a person word in "${text}"`);
});

test('a chest the app was busy with and then gave back idle is refused at once, not after the wait for a press it ignored', async () => {
  const chest = makeChest({ busyMs: 40, outcome: 'refuses' });
  const run = load({ left: chest, constants: { NOTHING_HAPPENED_MS: 1500 } });
  await sleep(300);
  run.dispose();
  assert.equal(run.warnings.length, 1, 'said so within 300 ms, long before the 1.5 s a press that was ignored is given');
});
