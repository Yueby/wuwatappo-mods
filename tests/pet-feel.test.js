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

// The page's frames, for the turning: a queue that a test moves along, `ms` at a time.
let clock = performance.now();
let queue = [];
globalThis.requestAnimationFrame = fn => { queue.push(fn); return queue.length; };
globalThis.cancelAnimationFrame = () => { queue = []; };
function frames(count, ms = 16) {
  for (let i = 0; i < count; i += 1) {
    clock += ms;
    const now = queue;
    queue = [];
    for (const fn of now) fn(clock);
  }
}

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
  queue = [];
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

test('what it declares: the main window, the patched pieces it needs, the api, a switch for each motion and the strength, and no person words', () => {
  assert.deepEqual(manifest.modkit.windows, { main: 'main.js' });
  assert.deepEqual(manifest.modkit.permissions, ['app-internals']);
  assert.equal(manifest.modkit.api, 10);
  assert.deepEqual(manifest.modkit.settings.map(s => s.key), ['press', 'drag', 'release', 'click', 'throw', 'spin', 'gravity', 'strength']);
  assert.ok(manifest.modkit.settings.filter(s => s.type === 'toggle').every(s => s.default === true), 'every motion is on to begin with');
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

// The person drags: the loader tells each frame how the hand moves, and, at the release, how fast it was going.
function pull(run, send, vx, vy = 0, frames = 8) {
  send({ type: 'press' });
  send({ type: 'dragstart' });
  for (let i = 0; i < frames; i += 1) send({ type: 'drag', vx, vy });
}

const letGo = (send, vx = 0, vy = 0, extra = {}) => send({ type: 'release', moved: true, heldMs: 700, vx, vy, ...extra });

test('let go while the hand is fast, the pet is thrown with the speed of the hand, and with what makes it fall, bounce and roll', () => {
  const run = load();
  pull(run, run.me, 1800, -600);
  letGo(run.me, 1800, -600);
  assert.equal(run.glides.length, 1);
  const { key, options } = run.glides[0];
  assert.equal(key, 'me');
  assert.equal(options.vx, 1800);
  assert.equal(options.vy, -600);
  assert.equal(run.own.mode(), 'fly');
  assert.ok(options.gravity > 1000 && options.friction < 1.5, 'it falls, and keeps its speed in the air');
  assert.ok(options.bounceY < options.bounce, 'it keeps less of its speed off the floor than off a side');
  assert.ok(options.floorFriction < 1 && options.floorDecel > 100, 'and rolls on the floor for as far as its speed says: slowed by a push, not by a share of its speed');
});

test('every pet is thrown the same way for the same hand: the person\'s own and a player\'s', () => {
  const run = load();
  run.friend(95007);
  letGo(run.me, 1500, -900);
  letGo(event => run.member(95007, event), 1500, -900);
  const [mine, theirs] = run.glides;
  assert.equal(mine.key, 'me');
  assert.equal(theirs.key, '95007');
  assert.deepEqual({ ...theirs.options, onFrame: 0, onBump: 0, onEnd: 0 }, { ...mine.options, onFrame: 0, onBump: 0, onEnd: 0 });
});

test('the speed is the one the loader says at the release, and nothing that came before it', () => {
  const run = load();
  pull(run, run.me, 2500);
  letGo(run.me, 40, 0);                                                    // the hand had stopped
  assert.equal(run.glides.length, 0, 'not thrown');
  assert.equal(run.own.mode(), 'bounce');

  const old = load();                                                      // a release that does not say a speed
  pull(old, old.me, 2500);
  old.me({ type: 'release', moved: true, heldMs: 700 });
  assert.equal(old.glides.length, 0);

  const slow = load();
  pull(slow, slow.me, 200);
  letGo(slow.me, 200, 0);
  assert.equal(slow.glides.length, 0, 'let go slowly, it is only put down');
  assert.equal(slow.own.mode(), 'bounce');

  const click = load();
  click.me({ type: 'press' });
  click.me({ type: 'release', moved: false, heldMs: 60, vx: 3000, vy: 0 });
  assert.equal(click.glides.length, 0, 'a click is not a throw, whatever the pointer did');
});

test('it is not thrown faster than the most it can be, and keeps the way it was going', () => {
  const run = load();
  letGo(run.me, 9000, 9000);
  const { options } = run.glides[0];
  assert.ok(Math.hypot(options.vx, options.vy) <= 4601, `${Math.hypot(options.vx, options.vy)}`);
  assert.ok(Math.abs(options.vx - options.vy) < 1);
});

// --- turning ----------------------------------------------------------------------------------------------------

const rotOf = node => Number(node.props.get('--wf-rot') ?? 0);

test('it turns as it flies, the way it was thrown, and a thrown pet turns the same whoever it is', () => {
  const right = load();
  letGo(right.me, 2400, -500);
  frames(10);
  assert.ok(rotOf(right.own) > 25, `turned forward: ${rotOf(right.own)}`);

  const left = load();
  letGo(left.me, -2400, -500);
  frames(10);
  assert.ok(rotOf(left.own) < -25, `and the other way: ${rotOf(left.own)}`);

  const friend = load();
  const node = friend.friend(95007);
  letGo(event => friend.member(95007, event), 2400, -500);
  frames(10);
  assert.ok(Math.abs(rotOf(node) - rotOf(right.own)) < 0.5, 'a player\'s pet turns exactly as the person\'s own does');
});

test('on the floor it turns as a wheel would for the way it goes: it rolls', () => {
  const run = load();
  letGo(run.me, 1200, 0);
  const { options } = run.glides[0];
  const angles = [];
  for (let i = 0; i < 120; i += 1) {
    options.onFrame({ vx: 900, vy: 0, left: 0, top: 0, floor: true });
    frames(1);
    angles.push(rotOf(run.own));
  }
  const rate = ((angles[119] - angles[99]) / (20 * 0.016));                // degrees a second near the end
  const wheel = (900 / 40) * (180 / Math.PI);
  assert.ok(Math.abs(rate - wheel) < wheel * 0.12, `turning at ${rate.toFixed(0)} degrees a second, a wheel does ${wheel.toFixed(0)}`);
});

test('it hops a little on the floor, and between the hops it still rolls', () => {
  const run = load();
  letGo(run.me, 1200, 0);
  const { options } = run.glides[0];
  const angles = [];
  for (let i = 0; i < 160; i += 1) {
    options.onFrame({ vx: 900, vy: 0, left: 0, top: 0, floor: i % 6 === 0 });     // in contact one frame in six
    frames(1);
    angles.push(rotOf(run.own));
  }
  const rate = (angles[159] - angles[119]) / (40 * 0.016);
  assert.ok(rate > 900, `still turning at ${rate.toFixed(0)} degrees a second`);
});

test('what it hits turns it: the floor rubs it the way it was going', () => {
  const rub = angle => {
    const run = load();
    letGo(run.me, 100, -500);                                                // hardly turning to begin with
    const { options } = run.glides[0];
    options.onFrame({ vx: 1200, vy: 800, left: 0, top: 0, floor: false });
    if (angle) options.onBump({ axis: 'y', speed: 800, side: 'max' });
    frames(8);
    return rotOf(run.own);
  };
  assert.ok(rub(true) > rub(false) + 5, `${rub(true)} against ${rub(false)}`);
});

test('when it has stopped it rights itself with a wobble, and ends upright with a last squash', async () => {
  const run = load();
  letGo(run.me, 2000, -300);
  const { options } = run.glides[0];
  frames(8);
  const tipped = rotOf(run.own);
  assert.ok(tipped > 15 && tipped < 180, `it was turned part of the way: ${tipped}`);
  options.onFrame({ vx: 0, vy: 0, left: 0, top: 0, floor: true });
  options.onEnd({ why: 'rest' });
  assert.equal(run.own.mode(), 'roll', 'it is righting itself');
  const seen = [];
  for (let i = 0; i < 400 && run.own.mode() === 'roll'; i += 1) {
    frames(1);
    seen.push(rotOf(run.own));
  }
  assert.ok(Math.min(...seen) < -1, `it goes past upright and comes back (lowest ${Math.min(...seen).toFixed(1)})`);
  assert.equal(run.own.mode(), 'bounce', 'upright and still: the last squash');
  assert.equal(rotOf(run.own), 0);
  await sleep(120);
  assert.equal(run.own.mode(), null);
});

test('the turning follows the speed on the floor all the way down: as it slows it turns slower, and the other way when it goes back', () => {
  const run = load();
  letGo(run.me, 1500, 0);
  const { options } = run.glides[0];
  const wheel = vx => (vx / 40) * (180 / Math.PI);
  const rateAt = vx => {
    for (let i = 0; i < 20; i += 1) { options.onFrame({ vx, vy: 0, left: 0, top: 0, floor: true }); frames(1); }
    const from = rotOf(run.own);
    for (let i = 0; i < 20; i += 1) { options.onFrame({ vx, vy: 0, left: 0, top: 0, floor: true }); frames(1); }
    return (rotOf(run.own) - from) / (20 * 0.016);
  };
  for (const vx of [1200, 700, 300, 150]) {
    const rate = rateAt(vx);
    assert.ok(Math.abs(rate - wheel(vx)) < wheel(vx) * 0.06, `at ${vx} px a second it turns ${rate.toFixed(0)} degrees a second, a wheel ${wheel(vx).toFixed(0)}`);
  }
  const back = rateAt(-500);
  assert.ok(Math.abs(back - wheel(-500)) < Math.abs(wheel(-500)) * 0.06, `and turns back at ${back.toFixed(0)}`);
});

test('a pet that is rolling fast is not pulled upright until it has slowed', () => {
  const run = load();
  letGo(run.me, 2000, 0);
  const { options } = run.glides[0];
  for (let i = 0; i < 90; i += 1) {
    options.onFrame({ vx: 1500, vy: 0, left: 0, top: 0, floor: true });
    frames(1);
  }
  assert.ok(Math.abs(rotOf(run.own)) > 300, `still turning over: ${rotOf(run.own)}`);
  for (let i = 0; i < 400; i += 1) {
    options.onFrame({ vx: 10, vy: 0, left: 0, top: 0, floor: true });
    frames(1);
  }
  assert.ok(Math.abs(rotOf(run.own) % 360) < 3 || Math.abs(rotOf(run.own) % 360) > 357, `and upright once it is slow: ${rotOf(run.own)}`);
});

test('taking the pet while it turns turns it upright in the hand', () => {
  const run = load();
  letGo(run.me, 2400, -500);
  frames(10);
  assert.ok(Math.abs(rotOf(run.own)) > 20);
  run.me({ type: 'press' });
  assert.equal(run.own.mode(), 'down');
  frames(150);
  assert.equal(rotOf(run.own), 0);
  assert.equal(run.own.mode(), 'down', 'and it is still pressed: the end of the turning does not bounce it');
});

test('the switch for turning off: it leans the way it goes, as before, and does not turn', () => {
  const run = load({ config: { spin: false } });
  letGo(run.me, 1500, 0);
  const { options } = run.glides[0];
  for (let i = 0; i < 40; i += 1) options.onFrame({ vx: 1500, vy: 0, left: 0, top: 0 });
  assert.ok(rotOf(run.own) > 8 && rotOf(run.own) <= 16.5, `leaning: ${rotOf(run.own)}`);
  frames(30);
  assert.ok(rotOf(run.own) <= 16.5, 'and nothing else turns it');
  options.onEnd({ why: 'rest' });
  assert.equal(run.own.mode(), 'bounce');
  assert.equal(rotOf(run.own), 0);
});

// --- the rest of the flight ---------------------------------------------------------------------------------------

test('it squashes against an edge it hits, along the way it hit it, and goes on flying', async () => {
  const run = load({ config: { spin: false } });
  letGo(run.me, 2000, 0);
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

test('taking the pet again while it flies stops it, and is a press', () => {
  const run = load();
  letGo(run.me, 1800, 0);
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
  letGo(event => run.member(95007, event), -1500, 300);
  assert.equal(run.glides.length, 1);
  assert.equal(run.glides[0].key, '95007');
  assert.ok(run.glides[0].options.vx < -1400);
  assert.equal(friend.mode(), 'fly');
  assert.equal(other.mode(), null);
  assert.equal(run.own.mode(), null);
});

test('switched off while a pet flies, the flight is stopped and nothing is left on the pet', () => {
  const run = load();
  letGo(run.me, 1800, 0);
  frames(4);
  run.dispose();
  assert.equal(run.glides[0].stopped, true);
  assert.equal(run.own.attributes.size, 0);
  assert.equal(run.own.props.size, 0);
  frames(4);
  assert.equal(run.own.props.size, 0, 'and the turning does not bring anything back');
});

// --- the switches, and gravity -----------------------------------------------------------------------------------

test('a thrown pet is pulled down: the gravity is given to the flight, and not when the switch for it is off', () => {
  const on = load();
  letGo(on.me, 1800, 0);
  assert.ok(on.glides[0].options.gravity > 1000, `pulled down: ${on.glides[0].options.gravity}`);

  const off = load({ config: { gravity: false } });
  letGo(off.me, 1800, 0);
  assert.equal(off.glides[0].options.gravity, 0, 'it glides on the way it was going');
  assert.equal(off.glides[0].options.friction, undefined, 'with the loader\'s own friction');
});

test('each switch takes away its own motion and leaves the others', () => {
  const none = (config, act) => {
    const run = load({ config });
    act(run);
    return run;
  };
  const noPress = none({ press: false }, run => run.me({ type: 'press' }));
  assert.equal(noPress.own.mode(), null);

  const noDrag = none({ drag: false }, run => { run.me({ type: 'press' }); run.me({ type: 'dragstart' }); });
  assert.equal(noDrag.own.mode(), null, 'neither lifted nor pressed');

  const noRelease = none({ release: false }, run => { pull(run, run.me, 100); letGo(run.me, 0, 0, { heldMs: 900 }); });
  assert.equal(noRelease.own.mode(), null, 'put down without a bounce');

  const noClick = none({ click: false }, run => { run.me({ type: 'press' }); run.me({ type: 'release', moved: false, heldMs: 60 }); });
  assert.equal(noClick.own.mode(), null, 'a click without a jump, and not left pressed');

  const noThrow = none({ throw: false }, run => { pull(run, run.me, 2500); letGo(run.me, 2500, 0); });
  assert.equal(noThrow.glides.length, 0, 'not thrown');
  assert.equal(noThrow.own.mode(), 'bounce', 'put down with the bounce');
});
