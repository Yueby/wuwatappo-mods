// mods/keep-on-top, run against a stand-in for the page: the window commands are written down as they are made, and what is said
// is read back. Nothing here touches the real app.
//
//   node --test tests/keep-on-top.test.js

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const folder = path.join(import.meta.dirname, '..', 'mods', 'keep-on-top');
const source = await fs.readFile(path.join(folder, 'main.js'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const running = [];
after(() => running.forEach(run => run.dispose()));

// A second is a millisecond here: 5 seconds is 5 ms.
assert.match(source, /const SECOND_MS = 1000;/);
const fast = source.replace('const SECOND_MS = 1000;', 'const SECOND_MS = 1;');

// `failOn`: the numbers (from 1) of the flag commands that fail; `failVisible`: the question whether it is shown fails; `stallOn`: the
// number of the flag command that does not answer until `state.release()` (the moment between the flag off and on).
function load({ interval = 5, gameMode = false, visible = true, dragging = false, failOn = [], failVisible = false, stallOn = 0 } = {}) {
  const commands = [];
  const said = [];
  const warned = [];
  const disposers = [];
  const watchers = [];
  const settings = { interval };
  const state = { gameMode, visible, dragging, release: () => {} };
  const mod = {
    config: { get: key => settings[key], onChange: (key, fn) => watchers.push([key, fn]) },
    live: (key, value) => said.push([key, value]),
    warn: text => warned.push(text),
    onDispose: fn => disposers.push(fn),
    async invoke(cmd, args) {
      commands.push(`${cmd.replace('plugin:window|', '')} ${args.label}${'value' in args ? ` ${args.value}` : ''}`);
      if (cmd.endsWith('is_visible')) {
        if (failVisible) throw new Error('window gone');
        return state.visible;
      }
      const number = commands.filter(c => c.startsWith('set_always_on_top')).length;
      if (number === stallOn) await new Promise(resolve => { state.release = resolve; });
      if (failOn.includes(number)) throw new Error('window gone');
      return undefined;
    },
  };
  const document = { querySelector: selector => (state.dragging && selector === '.pet-dock--dragging' ? {} : null) };
  const localStorage = { getItem: key => (key === 'wuwatappo-settings' ? JSON.stringify({ gameMode: state.gameMode }) : null) };
  new AsyncFunction('mod', 'document', 'localStorage', fast)(mod, document, localStorage);
  const run = {
    commands, said, warned, state, settings, watchers,
    dispose: () => disposers.forEach(fn => fn()),
    last: () => said.at(-1)?.[1],
  };
  running.push(run);
  return run;
}

test('what it declares: the main window, one setting for how often, a figure for how it is doing, and no person words', () => {
  assert.deepEqual(manifest.modkit.windows, { main: 'main.js' });
  assert.deepEqual(manifest.modkit.permissions, ['app-commands']);
  assert.deepEqual(manifest.modkit.settings.map(s => [s.key, s.type]), [['interval', 'number'], ['state', 'value']]);
  const interval = manifest.modkit.settings[0];
  assert.deepEqual([interval.min, interval.max, interval.default], [5, 120, 15]);
  const code = source.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  assert.ok(!/fetch\(|XMLHttpRequest|new WebSocket/.test(code), 'it only turns a window flag off and on');
  for (const text of [manifest.description, manifest.displayName, ...manifest.modkit.settings.flatMap(s => [s.title, s.description].filter(Boolean)), ...[...source.matchAll(/['`]([^'`\n]*[一-鿿][^'`\n]*)['`]/g)].map(m => m[1])]) {
    assert.ok(!/[我咱您你她]|(?<!其)他/.test(text), `a person word in "${text}"`);
  }
});

test('every round turns the flag off and on again, in that order, and says so', async () => {
  const run = load();
  assert.equal(run.last(), '运行中');
  await sleep(40);
  const sets = run.commands.filter(c => c.startsWith('set_always_on_top'));
  assert.ok(sets.length >= 4, `rounds: ${sets.length}`);
  for (let i = 0; i < sets.length - 1; i += 2) assert.deepEqual(sets.slice(i, i + 2), ['set_always_on_top main false', 'set_always_on_top main true']);
  assert.match(run.last(), /^已置顶 \d+ 次，最近一次 \d\d:\d\d:\d\d$/);
});

test('the window is asked whether it is shown before anything is done, and a hidden one is left alone', async () => {
  const run = load({ visible: false });
  await sleep(30);
  assert.ok(run.commands.every(c => c.startsWith('is_visible')), run.commands.join());
  assert.equal(run.last(), '窗口已隐藏，未置顶');
});

test('in game mode, or while the pet is dragged, nothing is done', async () => {
  const game = load({ gameMode: true });
  await sleep(30);
  assert.deepEqual(game.commands, []);
  assert.equal(game.last(), '游戏模式中，未置顶');

  const drag = load({ dragging: true });
  await sleep(30);
  assert.deepEqual(drag.commands, []);
});

test('coming out of game mode starts it again, with no change to the plugin', async () => {
  const run = load({ gameMode: true });
  await sleep(20);
  assert.deepEqual(run.commands, []);
  run.state.gameMode = false;
  await sleep(30);
  assert.ok(run.commands.some(c => c === 'set_always_on_top main true'));
});

const flagCommands = run => run.commands.filter(c => c.startsWith('set_always_on_top'));

test('a window that cannot be turned on again is tried again at once, so the flag is not left off', async () => {
  const run = load({ interval: 120, failOn: [2] });              // the second flag command fails: the one that turns it on (120 s: no round yet)
  run.settings.interval = 5;
  run.watchers.find(([key]) => key === 'interval')[1]();         // the person sets a short interval: taken up at once
  await sleep(14);
  assert.deepEqual(flagCommands(run).slice(0, 3), ['set_always_on_top main false', 'set_always_on_top main true', 'set_always_on_top main true'], 'off, the on that failed, and the one that puts it back');
  assert.equal(run.warned.length, 1);
  assert.match(run.warned[0], /window gone/);
  // said at some point (a later round, on a slow machine, goes on and says it is on top again, so the last word is not the one to look at)
  assert.ok(run.said.some(([, text]) => /^置顶失败：window gone$/.test(text)), run.said.map(s => s[1]).join(' / '));
});

test('the same failure is said once, not at every round, and is not said as something that went wrong when the window is only hidden', async () => {
  const broken = load({ failVisible: true });
  await sleep(80);
  assert.ok(broken.commands.length >= 2, `it went on trying (${broken.commands.length} questions)`);
  assert.equal(broken.warned.length, 1, 'said once');

  const hidden = load({ visible: false });
  await sleep(40);
  assert.equal(hidden.warned.length, 0);
});

test('the interval is the one set, between 5 and 120 seconds', async () => {
  const rounds = run => flagCommands(run).length / 2;
  const slow = load({ interval: 9000 });                           // above the most: 120 s, that is 120 ms here
  await sleep(60);
  assert.equal(rounds(slow), 0, 'not before the most');
  await sleep(120);
  assert.ok(rounds(slow) >= 1, 'and then it is');

  const quick = load({ interval: 1 });                             // below the least: 5 s, that is 5 ms
  await sleep(60);
  assert.ok(rounds(quick) >= 3 && rounds(quick) <= 13, `${rounds(quick)} rounds in 60 ms`);

  const unreadable = load({ interval: 'x' });                      // 15 s, that is 15 ms
  await sleep(80);
  assert.ok(rounds(unreadable) >= 2 && rounds(unreadable) <= 6, `${rounds(unreadable)} rounds in 80 ms`);
});

test('switched off, the rounds stop; and switched off while the flag is off, it is put back at once', async () => {
  const run = load({ stallOn: 2 });                                // the command that turns it on does not answer yet
  await sleep(14);
  assert.deepEqual(flagCommands(run), ['set_always_on_top main false', 'set_always_on_top main true'], 'off, and the on is waiting');
  run.dispose();
  assert.equal(flagCommands(run).at(-1), 'set_always_on_top main true');
  assert.equal(flagCommands(run).length, 3, 'one more: the one that puts it back');
  run.state.release();
  const count = run.commands.length;
  await sleep(40);
  assert.equal(run.commands.length, count, 'nothing after it stopped');
});
