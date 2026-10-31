// mods/pet-feel, run against a stand-in for what the loader gives (`mod.app.pet.onInteraction` and the pet's element):
// the events of a press, a drag and a release are sent by hand and what is on the element is looked at. Nothing here
// touches the real app.
//
//   node --test tests/pet-feel.test.js

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const folder = path.join(import.meta.dirname, '..', 'mods', 'pet-feel');
const source = await fs.readFile(path.join(folder, 'main.js'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const running = [];
after(() => running.forEach(run => run.dispose()));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The waits are about half a second; a test cannot wait that.
let fast = source;
for (const [name, value] of Object.entries({ CLICK_MS: 250, BOUNCE_MS: 60, BUMP_MS: 40 })) {
  const pattern = new RegExp(`const ${name} = [\\d_]+;`);
  assert.match(fast, pattern, `${name} is in the mod`);
  fast = fast.replace(pattern, `const ${name} = ${value};`);
}

function element() {
  const attributes = new Map();
  const props = new Map();
  return {
    attributes, props,
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: key => attributes.delete(key),
    getAttribute: key => attributes.get(key) ?? null,
    style: { setProperty: (key, value) => props.set(key, value), removeProperty: key => props.delete(key) },
    mode() { return attributes.get('data-wf') ?? null; },
  };
}

function load({ config = {} } = {}) {
  const settings = { strength: 1, ...config };
  const nodes = { me: element() };
  const sheets = [];
  const handlers = { me: null, members: null };
  const glides = [];                                         // what was thrown: { key, options, stopped }
  const disposers = [];
  const mod = {
    log() {},
    css: text => { sheets.push(text); return () => {}; },
    onDispose: fn => disposers.push(fn),
    config: { get: key => settings[key] },
    app: {
      pet: { content: () => nodes.me, onInteraction: fn => { handlers.me = fn; }, glide: options => { const g = { key: 'me', options, stopped: false }; glides.push(g); return { stop() { g.stopped = true; } }; } },
      members: { element: id => nodes[String(id)] ?? null, onInteraction: fn => { handlers.members = fn; }, glide: (id, options) => { const g = { key: String(id), options, stopped: false }; glides.push(g); return { stop() { g.stopped = true; } }; } },
    },
  };
  new AsyncFunction('mod', fast)(mod);
  const run = {
    nodes, sheets, settings, glides,
    own: nodes.me,
    dispose: () => disposers.forEach(fn => fn()),
    me: event => handlers.me(event),
    member: (id, event) => handlers.members({ id, ...event }),
    friend(id) { nodes[String(id)] = element(); return nodes[String(id)]; },
  };
  running.push(run);
  return run;
}

test('what it declares: the main window, the patched pieces it needs, the api, one setting and no person words', () => {
  assert.deepEqual(manifest.modkit.windows, { main: 'main.js' });
  assert.deepEqual(manifest.modkit.permissions, ['app-internals']);
  assert.equal(manifest.modkit.api, 7);
  assert.deepEqual(manifest.modkit.settings.map(s => s.key), ['strength']);
  const code = source.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  assert.ok(!/fetch\(|XMLHttpRequest|new WebSocket|localStorage|invoke\(/.test(code), 'it only changes how the pet looks');
  const strings = [...code.matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)].map(m => m[1] ?? m[2]).filter(text => /[一-鿿]/.test(text));
  for (const text of [manifest.description, manifest.displayName, ...manifest.modkit.settings.flatMap(s => [s.title, s.description]), ...strings]) assert.ok(!/[我咱您你她]|(?<!其)他/.test(text), `a person word in "${text}"`);
});

test('the motion is a stylesheet on the pet\'s body, from its feet, springy, and gives way to a person who wants less motion', () => {
  const run = load();
  const css = run.sheets.join('');
  for (const name of ['wf-bounce', 'wf-pop', 'wf-dangle']) assert.match(css, new RegExp(`@keyframes ${name}`));
  assert.match(css, /transform-origin: 50% 100%/);
  assert.match(css, /cubic-bezier\(\.3, 1\.7, \.5, 1\)/, 'a spring that goes past and comes back');
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.ok(!/\.pet-dock(?![-\w])/.test(css), 'the dock, which holds the size of the pet, is not touched');
  assert.ok(!/\.wf-(down|drag|bounce|pop)\b/.test(css), 'attributes, not classes: the app takes the classes of a player\'s pet away whenever it is picked up or put down');
});

test('pressed: the body is pressed down; dragged: picked up and swung the way it is pulled; let go: it bounces', async () => {
  const run = load();
  run.me({ type: 'press' });
  assert.equal(run.own.mode(), 'down');
  assert.equal(run.own.props.get('--wf-k'), '1');
  run.me({ type: 'dragstart' });
  assert.equal(run.own.mode(), 'drag');
  const tilts = [];
  for (let i = 0; i < 40; i += 1) {
    run.me({ type: 'drag', vx: 900, vy: 0 });
    tilts.push(Number(run.own.props.get('--wf-tilt')));
  }
  assert.ok(Math.max(...tilts) > 16, `the spring goes past where it is pulled to (${Math.max(...tilts).toFixed(1)})`);
  assert.ok(Math.abs(tilts.at(-1) - 16) < 2.5 && tilts.at(-1) > 12, `and settles near it: ${tilts.at(-1).toFixed(1)}`);
  for (let i = 0; i < 60; i += 1) run.me({ type: 'drag', vx: -900, vy: 0 });
  assert.ok(Number(run.own.props.get('--wf-tilt')) < -12, 'and swings the other way when pulled the other way');
  for (let i = 0; i < 12; i += 1) run.me({ type: 'drag', vx: 0, vy: 0 });                 // held still, then let go: only put down
  run.me({ type: 'release', moved: true, heldMs: 900 });
  assert.equal(run.own.mode(), 'bounce');
  await sleep(120);
  assert.equal(run.own.mode(), null, 'the bounce is over: the attribute is gone');
});

test('a quick press and release is a click: the pet jumps; a long press that did not move bounces', async () => {
  const run = load();
  run.me({ type: 'press' });
  run.me({ type: 'release', moved: false, heldMs: 90 });
  assert.equal(run.own.mode(), 'pop');
  await sleep(120);
  assert.equal(run.own.mode(), null);
  run.me({ type: 'press' });
  run.me({ type: 'release', moved: false, heldMs: 700 });
  assert.equal(run.own.mode(), 'bounce');
});

test('the strength is the size of the motion, kept between 0.5 and 2', () => {
  for (const [value, expected] of [[1.6, '1.6'], [9, '2'], [0.1, '0.5'], ['x', '1']]) {
    const run = load({ config: { strength: value } });
    run.me({ type: 'press' });
    assert.equal(run.own.props.get('--wf-k'), expected, `strength ${value}`);
  }
});

test('the other players\' pets get all of it, each its own', async () => {
  const run = load();
  const a = run.friend(95007);
  const b = run.friend(110283);
  run.member(95007, { type: 'press' });
  run.member(110283, { type: 'press' });
  run.member(95007, { type: 'dragstart' });
  for (let i = 0; i < 10; i += 1) run.member(95007, { type: 'drag', vx: 600, vy: 0 });
  assert.equal(a.mode(), 'drag');
  assert.equal(b.mode(), 'down', 'two at once, apart');
  assert.ok(Number(a.props.get('--wf-tilt')) > 5, 'swung too');
  for (let i = 0; i < 12; i += 1) run.member(95007, { type: 'drag', vx: 0, vy: 0 });
  run.member(95007, { type: 'release', moved: true, heldMs: 400 });
  run.member(110283, { type: 'release', moved: false, heldMs: 80 });
  assert.equal(a.mode(), 'bounce');
  assert.equal(b.mode(), 'pop');
  assert.equal(run.own.mode(), null, 'the person\'s own is not touched by theirs');
  run.member(777, { type: 'press' });                                       // one that is not in the page: nothing to do
  await sleep(120);
  assert.equal(a.mode(), null);
});

test('a pet the app draws again in the middle of what the person does gets the rest of it', () => {
  const run = load();
  const first = run.friend(95007);
  run.member(95007, { type: 'press' });
  run.member(95007, { type: 'dragstart' });
  assert.equal(first.mode(), 'drag');
  const again = run.friend(95007);                                          // the app made the element anew
  run.member(95007, { type: 'drag', vx: 300, vy: 0 });
  assert.equal(again.mode(), 'drag', 'the motion goes on on the new one');
  run.member(95007, { type: 'release', moved: true, heldMs: 500 });
  assert.equal(again.mode(), 'bounce');
});

test('switched off, the pets are as they were: no attribute, no variable, nothing left to end', async () => {
  const run = load();
  const friend = run.friend(5);
  run.me({ type: 'press' });
  run.me({ type: 'dragstart' });
  run.me({ type: 'drag', vx: 400, vy: 0 });
  run.me({ type: 'release', moved: true, heldMs: 300 });
  run.member(5, { type: 'press' });
  run.dispose();
  assert.equal(run.own.attributes.size, 0);
  assert.equal(run.own.props.size, 0);
  assert.equal(friend.attributes.size, 0);
  assert.equal(friend.props.size, 0);
  await sleep(100);
  assert.equal(run.own.attributes.size, 0, 'and the timer of the bounce does not bring anything back');
});

test('a loader without the events of a pet says so and does nothing', () => {
  const disposers = [];
  const logs = [];
  new AsyncFunction('mod', fast)({ log: text => logs.push(text), css() { throw new Error('no'); }, onDispose: fn => disposers.push(fn), config: { get: () => undefined }, app: {} });
  assert.match(logs.join(''), /更新加载器/);
  disposers.forEach(fn => fn());
});

// --- throwing ---------------------------------------------------------------------------------------------------

// The person drags at a speed and lets go: the pet is thrown with it.
function pull(run, send, vx, vy = 0, frames = 8) {
  send({ type: 'press' });
  send({ type: 'dragstart' });
  for (let i = 0; i < frames; i += 1) send({ type: 'drag', vx, vy });
}

test('let go while being pulled fast, the pet is thrown with that speed, and flies leaning the way it goes', () => {
  const run = load();
  pull(run, run.me, 1800, -600);
  run.me({ type: 'release', moved: true, heldMs: 700 });
  assert.equal(run.glides.length, 1);
  const { key, options } = run.glides[0];
  assert.equal(key, 'me');
  assert.ok(Math.abs(options.vx - 1800) < 40 && Math.abs(options.vy + 600) < 20, `the speed it was pulled at: ${options.vx}, ${options.vy}`);
  assert.equal(run.own.mode(), 'fly');
  for (let i = 0; i < 40; i += 1) options.onFrame({ vx: 1500, vy: 0, left: 0, top: 0 });
  assert.ok(Number(run.own.props.get('--wf-tilt')) > 8, 'leaning forward');
});

test('it squashes against an edge it hits, along the way it hit it, and goes on flying; where it stops, it lands with a bounce', async () => {
  const run = load();
  pull(run, run.me, 2000);
  run.me({ type: 'release', moved: true, heldMs: 700 });
  const { options } = run.glides[0];
  options.onBump({ axis: 'x', speed: 900, side: 'max' });
  assert.equal(run.own.mode(), 'bump-x');
  options.onBump({ axis: 'y', speed: 500, side: 'max' });
  assert.equal(run.own.mode(), 'bump-y');
  await sleep(100);
  assert.equal(run.own.mode(), 'fly', 'back to flying when the squash is over');
  options.onEnd({ why: 'rest' });
  assert.equal(run.own.mode(), 'bounce');
  await sleep(120);
  assert.equal(run.own.mode(), null);
});

test('let go slowly, or after holding still, or at more than a click that did not move, it is only put down', () => {
  const slow = load();
  pull(slow, slow.me, 200);
  slow.me({ type: 'release', moved: true, heldMs: 900 });
  assert.equal(slow.glides.length, 0);
  assert.equal(slow.own.mode(), 'bounce');

  const still = load();
  pull(still, still.me, 2500);
  for (let i = 0; i < 12; i += 1) still.me({ type: 'drag', vx: 0, vy: 0 });                    // held still for a moment before letting go
  still.me({ type: 'release', moved: true, heldMs: 2000 });
  assert.equal(still.glides.length, 0, 'the speed is the one at the moment of letting go');

  const click = load();
  click.me({ type: 'press' });
  click.me({ type: 'release', moved: false, heldMs: 60 });
  assert.equal(click.glides.length, 0);
});

test('it is not thrown faster than the most it can be', () => {
  const run = load();
  pull(run, run.me, 9000, 9000, 12);
  run.me({ type: 'release', moved: true, heldMs: 700 });
  const { options } = run.glides[0];
  assert.ok(Math.hypot(options.vx, options.vy) <= 4201, `${Math.hypot(options.vx, options.vy)}`);
  assert.ok(Math.abs(options.vx - options.vy) < 1, 'the way it was going is kept');
});

test('taking the pet again while it flies stops it, and is a press', () => {
  const run = load();
  pull(run, run.me, 1800);
  run.me({ type: 'release', moved: true, heldMs: 700 });
  const thrown = run.glides[0];
  run.me({ type: 'press' });
  assert.equal(thrown.stopped, true);
  assert.equal(run.own.mode(), 'down');
  thrown.options.onEnd({ why: 'grabbed' });                                    // what the loader says when it is taken
  assert.equal(run.own.mode(), 'down', 'the pressing is not undone by the end of the flight');
});

test('a player\'s pet is thrown too, with its own flight', () => {
  const run = load();
  const friend = run.friend(95007);
  const other = run.friend(110283);
  pull(run, (event) => run.member(95007, event), -1500, 300);
  run.member(95007, { type: 'release', moved: true, heldMs: 500 });
  assert.equal(run.glides.length, 1);
  assert.equal(run.glides[0].key, '95007');
  assert.ok(run.glides[0].options.vx < -1400);
  assert.equal(friend.mode(), 'fly');
  assert.equal(other.mode(), null);
  assert.equal(run.own.mode(), null);
});

test('switched off while a pet flies, the flight is stopped', () => {
  const run = load();
  pull(run, run.me, 1800);
  run.me({ type: 'release', moved: true, heldMs: 700 });
  run.dispose();
  assert.equal(run.glides[0].stopped, true);
  assert.equal(run.own.attributes.size, 0);
});
