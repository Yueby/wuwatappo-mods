// The click loop of mods/auto-click, run against a stand-in for `mod`. Nothing here talks to the app, so
// no event is ever sent: this is how the loop is tested without clicking on anyone's account.
//
//   node --test tests/auto-click.test.js

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const source = await fs.readFile(path.join(import.meta.dirname, '..', 'mods', 'auto-click', 'main.js'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(import.meta.dirname, '..', 'mods', 'auto-click', 'package.json'), 'utf8'));
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

// Runs the mod's script with a fake `mod`, the way the framework does when the mod is switched on, and
// returns what it did. `dispose()` is the mod being switched off.
function load({ interval = 60, loggedIn = true, failEmitAt = null, sendMs = 0, timers = false } = {}) {
  const config = { interval };
  const disposers = [];
  const calls = [];                 // { event, payload, at }
  const live = {};
  const login = { in: loggedIn };

  const mod = {
    invoke: async (cmd, args) => {
      assert.equal(cmd, 'plugin:event|emit');
      calls.push({ event: args.event, payload: args.payload, at: Date.now() });
      if (sendMs) await sleep(sendMs);                          // the event is on its way for this long
      if (failEmitAt !== null && calls.length === failEmitAt) throw new Error('emit failed');
    },
    warn: () => {},
    live: (key, value) => { live[key] = value; },
    onDispose: fn => disposers.push(fn),
    config: { get: key => config[key] },
  };
  const localStorage = { getItem: () => (login.in ? 'cuid' : null) };

  const spy = timers ? makeTimers(timers !== 'real') : null;
  new AsyncFunction('mod', 'localStorage', 'setTimeout', 'clearTimeout', source)(mod, localStorage, spy?.setTimeout ?? setTimeout, spy?.clearTimeout ?? clearTimeout);
  const run = { mod, config, calls, live, login, spy, dispose: () => disposers.forEach(fn => fn()) };
  running.push(run);
  return run;
}

const gapsOf = calls => calls.map(c => c.at).map((t, i, all) => t - all[i - 1]).slice(1);

test('it is off until the person turns it on, and the master switch is the only switch', () => {
  assert.equal(manifest.modkit.defaultEnabled, false, 'a plugin that acts on the account starts off');
  assert.deepEqual(manifest.modkit.settings.map(s => s.key), ['interval', 'state', 'sent'], 'no switch of its own: the master switch is it');
});

test('switched on, it clicks: one global-clap-mouse event each, no key, no payload, no release to follow', async () => {
  const run = load({ interval: 60 });
  await sleep(300);
  run.dispose();

  assert.ok(run.calls.length >= 4, `expected several clicks, got ${run.calls.length}`);
  for (const call of run.calls) {
    assert.equal(call.event, 'global-clap-mouse');
    assert.equal(call.payload, undefined);
  }
  assert.equal(run.live.state, '运行中');
});

test('clicks follow the interval, and a changed interval applies while it runs', async () => {
  const run = load({ interval: 60 });
  await sleep(250);
  run.config.interval = 150;
  const changedAt = Date.now();
  await sleep(700);
  run.dispose();

  const before = run.calls.filter(c => c.at < changedAt - 80);
  const after = run.calls.filter(c => c.at > changedAt + 160);
  assert.ok(gapsOf(before).every(g => g >= 50 && g < 110), `early gaps ${gapsOf(before)}`);
  assert.ok(gapsOf(after).every(g => g >= 140 && g < 230), `later gaps ${gapsOf(after)}`);
});

test('switching it off stops it, and nothing is sent afterwards', async () => {
  const run = load({ interval: 40 });
  await sleep(120);
  run.dispose();
  await sleep(100);
  const after = run.calls.length;
  await sleep(250);
  assert.equal(run.calls.length, after, 'no further clicks once it is off');
});

test('not logged in: nothing is sent and it says it is waiting; once someone logs in it starts', async () => {
  const run = load({ loggedIn: false });
  await sleep(150);
  assert.equal(run.calls.length, 0);
  assert.equal(run.live.state, '等待登录');

  run.login.in = true;
  await sleep(2500);                       // it looks again every 2 s
  run.dispose();
  assert.ok(run.calls.length > 0, 'it started by itself');
  assert.equal(run.live.state, '运行中');
});

test('a failed send stops the loop and says so', async () => {
  const run = load({ failEmitAt: 3 });
  await sleep(400);
  assert.match(run.live.state, /已停止：emit failed/);
  assert.equal(run.calls.length, 3, 'it did not carry on after the failure');
  run.dispose();
});

// --- found by the review ------------------------------------------------------------------------------------

test('it says what it does in a room: the members see each click', () => {
  assert.match(manifest.description, /房间/, 'the description says so');
  assert.match(source, /tells the room about the click/, 'and so does the header, which used to say "nothing else"');
});

test('switched off while a click is on its way: nothing is counted or shown afterwards', async () => {
  const run = load({ interval: 60, sendMs: 80 });
  await sleep(30);
  assert.equal(run.calls.length, 1, 'the first event is on its way');
  run.dispose();
  await sleep(150);
  assert.equal(run.live.sent, undefined, 'the figure of a copy that is off is not written');
  assert.equal(run.calls.length, 1);
});

test('the counter is moving from the first click, not from the tenth', async () => {
  const run = load({ interval: 50 });
  await sleep(130);
  run.dispose();
  assert.match(run.live.sent, /^[1-9]\d* 次$/);
});

test('the interval is from one click to the next, so the time spent sending counts', async () => {
  const run = load({ interval: 100, sendMs: 70 });
  await sleep(650);
  run.dispose();
  const gaps = gapsOf(run.calls);
  assert.ok(gaps.length >= 3);
  assert.ok(gaps.every(g => g < 135), `gaps of about 100 ms, not 100 + 70: ${gaps.join(', ')}`);
});

test('switched off, no timer is left pending', async () => {
  const run = load({ interval: 5000, timers: 'real' });       // a long wait between clicks, as long as it is in earnest
  await sleep(40);
  assert.ok(run.spy.active.size > 0, 'it is waiting for the next click');
  run.dispose();
  assert.equal(run.spy.active.size, 0);
  await sleep(40);
  assert.equal(run.calls.length, 1, 'and nothing more is sent');
});

test('what it shows has no 我, 咱, 您, 你, 他, 她: labels and statements, like the app\'s own pages', () => {
  for (const text of displayedTexts(source, manifest)) assert.ok(!/[我咱您你她]|(?<!其)他/.test(text), `a person word in "${text}"`);
});
