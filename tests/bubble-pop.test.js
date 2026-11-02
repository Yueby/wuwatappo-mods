// mods/bubble-pop, run against a stand-in for the page: what it adds is a stylesheet and a variable, nothing else. The look
// of the animation itself was seen in the app (a bubble made by hand with the app's own classes, stepped through its second).
//
//   node --test tests/bubble-pop.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const folder = path.join(import.meta.dirname, '..', 'mods', 'bubble-pop');
const source = await fs.readFile(path.join(folder, 'main.js'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function load({ strength = 1 } = {}) {
  const sheets = [];
  const vars = new Map();
  const disposers = [];
  const watchers = [];
  globalThis.document = { documentElement: { style: { setProperty: (key, value) => vars.set(key, value), removeProperty: key => vars.delete(key) } } };
  const mod = {
    css: text => { sheets.push(text); return () => {}; },
    onDispose: fn => disposers.push(fn),
    config: { get: () => strength, onChange: (key, fn) => watchers.push([key, fn]) },
  };
  new AsyncFunction('mod', source)(mod);
  return { sheets, vars, watchers, dispose: () => disposers.forEach(fn => fn()) };
}

test('what it declares: the main window, the page, the api, one setting, and no person words', () => {
  assert.deepEqual(manifest.modkit.windows, { main: 'main.js' });
  assert.deepEqual(manifest.modkit.permissions, ['page']);
  assert.equal(manifest.modkit.api, 4);
  assert.deepEqual(manifest.modkit.settings.map(s => s.key), ['strength']);
  const code = source.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  assert.ok(!/fetch\(|XMLHttpRequest|new WebSocket|localStorage|invoke\(|mod\.app/.test(code), 'it only changes how a bubble looks');
  for (const text of [manifest.description, manifest.displayName, ...manifest.modkit.settings.flatMap(s => [s.title, s.description])]) {
    assert.ok(!/[我咱您你她]|(?<!其)他/.test(text), `a person word in "${text}"`);
  }
});

test('the bubble gets one animation of its own, with the length and the end the app gives it', () => {
  const { sheets } = load();
  const css = sheets.join('\n');
  assert.match(css, /@keyframes wb-bubble-pop/);
  assert.match(css, /\.local-emotion-bubble \{ animation-name: wb-bubble-pop;/);
  // the app takes its own bubble away when an animation of it ends, and an animation inside it counts too: so there is one,
  // it is the bubble's, and its length and `forwards` are the app's (not set here)
  assert.ok(!/animation-duration|animation-fill-mode|animation-iteration-count|animation:\s/.test(css), 'the length and the end stay the app\'s');
  assert.ok(!/__img[^{]*\{[^}]*animation/.test(css), 'nothing is animated inside the bubble');
  const steps = [...css.matchAll(/^\s+(\d+)%\s+\{/gm)].map(m => Number(m[1]));
  assert.equal(steps[0], 0);
  assert.equal(steps.at(-1), 100);
  assert.ok(steps.length >= 8, 'it springs more than once');
  assert.match(css, /100% \{ opacity: 0;/, 'and ends gone, as the app\'s own does');
});

test('it rises as far as the app says (--bubble-rise), and ends where the app\'s bubble ends', () => {
  const css = load().sheets.join('\n');
  const last = css.match(/100% \{[^}]*\}/)[0];
  assert.match(last, /translate\(-50%, calc\(-30% - var\(--bubble-rise, 102px\)\)\)/);
});

test('it squashes wide and stretches tall by the strength, kept between 0.5 and 2', () => {
  for (const [given, shown] of [[1.6, '1.6'], [9, '2'], [0.1, '0.5'], ['x', '1']]) {
    const { vars } = load({ strength: given });
    assert.equal(vars.get('--wb-k'), shown, `strength ${given}`);
  }
  const { watchers } = load();
  assert.deepEqual(watchers.map(([key]) => key), ['strength']);
});

test('a person who wants less motion gets the app\'s own rise', () => {
  const css = load().sheets.join('\n');
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.local-emotion-bubble \{ animation-name: local-emotion-float-up !important; \}/);
});

test('switched off, nothing is left on the page', () => {
  const { vars, dispose } = load();
  assert.equal(vars.size, 1);
  dispose();
  assert.equal(vars.size, 0);
});
