// Pet feel: springy motion for what the person does to a pet, the person's own and every other player's. Pressing it
// squashes the body down, lifting it (a drag) picks it up by the head so that it dangles and swings the way it is
// pulled, letting go drops it with a few bounces, and a quick press and release (a click) makes it jump and land.
// Let go while the hand is moving fast, and it is thrown: it goes on with the speed of the hand, is pulled down (gravity)
// and slows down, bounces off the edges of the screen (squashing against them), turns as it goes, rolls on the floor
// for as far as the speed takes it, and rights itself when it has stopped, wobbling a little. It lands where it stops, on the
// floor, which is its place from then on. Let go slowly, and it stays where it was put down.
//
// Every pet is the same: the person's own and every other player's are thrown by one piece of code, from the speed of
// the hand (the loader says it at the release: a line through the pointer's last 70 ms, `event.vx`, `event.vy`).
// What the person does is told by the app (`mod.app.pet.onInteraction`, `mod.app.members.onInteraction`: whether the
// pet is held and whether it has moved while held, looked at once a frame). The motion is
// an attribute on the pet's element (`data-wf`) and CSS on its body (`.cat-mainbox`, `.room-cat-pet`): a class would
// not do on a player's pet, because the app sets that element's classes again whenever it is picked up or put down,
// and takes the ones it does not know with it; an attribute it leaves alone. The pet's size, which the app sets on
// the element above the body, and its places are not touched (the body is squashed from its feet).

const CLICK_MS = 250;             // pressed and let go within this long, without moving, is a click
const BOUNCE_MS = 700;            // how long the bounce after a drag, and the jump of a click, are looked after
const TILT_MAX = 16;              // degrees of swinging at most, before the strength
const TILT_PER_PX = 1 / 38;       // degrees for each pixel a second the pet is pulled sideways
const SPRING = 0.2;               // how hard the swinging is pulled to where the pull says it should be
const DAMPING = 0.8;              // and how much of its speed it keeps each frame: less than 1, so it overshoots and settles
const THROW_MIN = 360;            // px a second: let go slower than this and it is only put down
const THROW_MAX = 4600;           // and it is not thrown faster than this
const BUMP_MS = 300;              // how long the squash against an edge is looked after
const GRAVITY = 2600;             // px a second every second, down, for a thrown pet
const AIR_FRICTION = 0.3;         // with gravity the speed it flies at is hardly lost in the air (a share a second); without, the loader's own
const FLOOR_FRICTION = 0.35;      // on the floor it slows down a little by the speed it has (a share a second)
const FLOOR_DECEL = 220;          // and by a push that does not depend on it (px a second, each second, about a twelfth of the gravity): a rolling thing
                                  // is slowed by about that whatever its speed is, so how far it rolls is what its speed says, the square of it
const WALL_BOUNCE = 0.62;         // the share of its speed it keeps off a side or the top
const FLOOR_BOUNCE = 0.46;        // and off the floor
const SPIN_PER_PX = 0.12;         // degrees a second it is turned at, for each px a second it is thrown sideways
const SPIN_MAX = 1000;            // degrees a second at most
const SPIN_AIR = 0.35;            // the share of its turning it loses each second in the air
const ROLL_RADIUS = 40;           // px: on the floor it turns as a wheel this big would, along with the way it goes
const ROLL_GRIP = 30;             // how fast, a share a second, its turning is made the rolling one when it lands (then it is exactly that)
const RIGHT_SPEED = 90;           // px a second: slower than this on the floor and it starts to right itself (faster, it only rolls)
const RIGHT_STIFFNESS = 170;      // how hard it is pulled upright
const RIGHT_DAMPING = 11;         // and how much it is held back: less than critical, so it wobbles before it stands still
const FLOOR_MS = 120;              // it is on the floor if it touched it this recently: it hops a little, and between hops it still rolls
const DEGREES = 180 / Math.PI;

const BODY = ':is(.cat-mainbox, .room-cat-pet)';
const EASE_SPRING = 'cubic-bezier(.3, 1.7, .5, 1)';
const CSS = `
@keyframes wf-bounce {
  0%   { transform: translateY(calc(-12px * var(--wf-k, 1))) scale(calc(1 + .06 * var(--wf-k, 1))) rotate(calc(var(--wf-tilt, 0) * 1deg)); }
  17%  { transform: translateY(0) scale(calc(1 + .20 * var(--wf-k, 1)), calc(1 - .24 * var(--wf-k, 1))); }
  36%  { transform: translateY(calc(-14px * var(--wf-k, 1))) scale(calc(1 - .10 * var(--wf-k, 1)), calc(1 + .16 * var(--wf-k, 1))); }
  54%  { transform: translateY(0) scale(calc(1 + .11 * var(--wf-k, 1)), calc(1 - .13 * var(--wf-k, 1))); }
  70%  { transform: translateY(calc(-4px * var(--wf-k, 1))) scale(calc(1 - .045 * var(--wf-k, 1)), calc(1 + .06 * var(--wf-k, 1))); }
  85%  { transform: scale(calc(1 + .02 * var(--wf-k, 1)), calc(1 - .025 * var(--wf-k, 1))); }
  100% { transform: none; }
}
@keyframes wf-pop {
  0%   { transform: scale(calc(1 + .10 * var(--wf-k, 1)), calc(1 - .16 * var(--wf-k, 1))); }
  24%  { transform: translateY(calc(-20px * var(--wf-k, 1))) scale(calc(1 - .09 * var(--wf-k, 1)), calc(1 + .16 * var(--wf-k, 1))); }
  52%  { transform: translateY(0) scale(calc(1 + .14 * var(--wf-k, 1)), calc(1 - .17 * var(--wf-k, 1))); }
  72%  { transform: translateY(calc(-3px * var(--wf-k, 1))) scale(calc(1 - .04 * var(--wf-k, 1)), calc(1 + .05 * var(--wf-k, 1))); }
  100% { transform: none; }
}
@keyframes wf-dangle {
  0%   { transform: translateY(calc(-12px * var(--wf-k, 1))) scale(calc(1 + .05 * var(--wf-k, 1)), calc(1 + .08 * var(--wf-k, 1))) rotate(calc(var(--wf-tilt, 0) * 1deg - 2deg)); }
  100% { transform: translateY(calc(-12px * var(--wf-k, 1))) scale(calc(1 + .05 * var(--wf-k, 1)), calc(1 + .08 * var(--wf-k, 1))) rotate(calc(var(--wf-tilt, 0) * 1deg + 2deg)); }
}
@keyframes wf-bump-x {
  0%   { transform: scale(calc(1 - .30 * var(--wf-k, 1)), calc(1 + .20 * var(--wf-k, 1))); }
  38%  { transform: scale(calc(1 + .10 * var(--wf-k, 1)), calc(1 - .08 * var(--wf-k, 1))); }
  70%  { transform: scale(calc(1 - .03 * var(--wf-k, 1)), calc(1 + .03 * var(--wf-k, 1))); }
  100% { transform: none; }
}
@keyframes wf-bump-y {
  0%   { transform: scale(calc(1 + .22 * var(--wf-k, 1)), calc(1 - .30 * var(--wf-k, 1))); }
  38%  { transform: scale(calc(1 - .08 * var(--wf-k, 1)), calc(1 + .10 * var(--wf-k, 1))); }
  70%  { transform: scale(calc(1 + .03 * var(--wf-k, 1)), calc(1 - .03 * var(--wf-k, 1))); }
  100% { transform: none; }
}
.pet-dock-content ${BODY}, .room-cat-shell ${BODY} { transform-origin: 50% 100%; }
/* The turning is the element's own rotate property, which goes with whatever transform is animating (a squash) and does not replace it. */
[data-wf] ${BODY} { rotate: calc(var(--wf-rot, 0) * 1deg); }
[data-wf="down"] ${BODY} { transform: scale(calc(1 + .10 * var(--wf-k, 1)), calc(1 - .16 * var(--wf-k, 1))); transition: transform 130ms ${EASE_SPRING}; }
[data-wf="drag"] ${BODY} { transform-origin: 50% 12%; animation: wf-dangle 520ms ease-in-out infinite alternate; filter: drop-shadow(0 calc(14px * var(--wf-k, 1)) calc(8px * var(--wf-k, 1)) rgba(90, 50, 20, .30)); }
[data-wf="fly"] ${BODY} { transform-origin: 50% 55%; transform: scale(calc(1 + .05 * var(--wf-k, 1))); filter: drop-shadow(0 calc(12px * var(--wf-k, 1)) calc(8px * var(--wf-k, 1)) rgba(90, 50, 20, .26)); }
[data-wf="roll"] ${BODY} { transform-origin: 50% 55%; }
[data-wf="bump-x"] ${BODY}, [data-wf="bump-y"] ${BODY} { transform-origin: 50% 55%; }
[data-wf="bump-x"] ${BODY} { animation: wf-bump-x ${BUMP_MS}ms ease-out; }
[data-wf="bump-y"] ${BODY} { animation: wf-bump-y ${BUMP_MS}ms ease-out; }
[data-wf="bounce"] ${BODY} { animation: wf-bounce ${BOUNCE_MS}ms ease-out; }
[data-wf="pop"] ${BODY} { animation: wf-pop 560ms ease-out; }
@media (prefers-reduced-motion: reduce) {
  [data-wf] ${BODY} { transform: none; rotate: none; animation: none; filter: none; transition: none; }
}
`;

const on = key => mod.config.get(key) !== false;
const strength = () => {
  const value = Number(mod.config.get('strength'));
  return Number.isFinite(value) ? Math.min(2, Math.max(0.5, value)) : 1;
};

// What each pet is doing: 'me' or a player's id -> { mode, tilt, speed, rot, spin, motion, glide, timer }.
// `rot` is the turning that is shown (degrees); `spin` is { angle, omega } while it is turning on its own; `motion` is how it was last
// moving when thrown, { vx, vy, floor }.
const states = new Map();

const elementOf = key => (key === 'me' ? mod.app.pet.content() : mod.app.members.element(key));

// What is on the element: the app may have drawn it anew since, so it is set each time and not remembered.
function paint(key, state) {
  const element = elementOf(key);
  if (!element) return;
  if (state.mode) element.setAttribute('data-wf', state.mode);
  else element.removeAttribute('data-wf');
  element.style.setProperty('--wf-k', String(strength()));
  element.style.setProperty('--wf-tilt', state.tilt.toFixed(2));
  element.style.setProperty('--wf-rot', state.rot.toFixed(2));
}

function set(key, state, mode, endsIn) {
  clearTimeout(state.timer);
  state.mode = mode;
  if (endsIn) {
    state.timer = setTimeout(() => {
      state.mode = '';
      paint(key, state);
    }, endsIn);
  }
  paint(key, state);
}

// Turning, once a frame, for every pet that is turning: in the air it goes on and slows; on the floor it is made to turn as a wheel
// would for the way it goes (it rolls); and when it is slow, or has stopped, it is pulled upright to the nearest standing
// position, with a little overshoot. It ends when it is upright and still.
let turning = 0;
let before = 0;

function turn(now) {
  turning = 0;
  const dt = Math.min(0.034, Math.max(0.001, (now - before) / 1000));
  before = now;
  let more = false;
  for (const [key, state] of states) {
    const spin = state.spin;
    if (!spin) continue;
    const motion = state.motion;
    const flying = !!state.glide;
    const onFloor = motion.floor || now - (motion.floorAt ?? -1e9) < FLOOR_MS;
    let authority = 1;                                              // how much it is pulled upright
    if (flying) {
      spin.omega *= Math.exp(-SPIN_AIR * dt);
      authority = onFloor ? Math.max(0, Math.min(1, 1 - Math.abs(motion.vx) / RIGHT_SPEED)) : 0;
      if (onFloor) {
        // rolling without slipping: the turning is the speed over the radius, whatever the speed is, as it slows and as it turns back
        const rolling = (motion.vx / ROLL_RADIUS) * DEGREES;
        const grip = 1 - Math.exp(-ROLL_GRIP * (1 - authority) * dt);
        spin.omega += (rolling - spin.omega) * grip;
        if (authority === 0 && Math.abs(rolling - spin.omega) < 25) spin.omega = rolling;
      }
    }
    if (authority > 0) {
      const upright = Math.round(spin.angle / 360) * 360;
      spin.omega += (RIGHT_STIFFNESS * (upright - spin.angle) - RIGHT_DAMPING * spin.omega) * authority * dt;
    }
    spin.angle += spin.omega * dt;
    state.rot = spin.angle;
    const standing = Math.round(spin.angle / 360) * 360;
    if (!flying && Math.abs(standing - spin.angle) < 0.6 && Math.abs(spin.omega) < 8) {
      state.spin = null;
      state.rot = 0;
      if (state.mode === 'roll') set(key, state, 'bounce', BOUNCE_MS);     // up, and it settles with a last squash
      else paint(key, state);
      continue;
    }
    paint(key, state);
    more = true;
  }
  if (more) turning = requestAnimationFrame(turn);
}

function startTurning() {
  if (turning) return;
  before = performance.now();
  turning = requestAnimationFrame(turn);
}

// What the floor, the side or the top does to the turning of what hits it: it rubs, and turns it the way it was going along it.
function rub(state, axis, side) {
  if (!state.spin) return;
  const sign = side === 'max' ? 1 : -1;
  if (axis === 'y') state.spin.omega += sign * state.motion.vx * 0.05;
  else state.spin.omega = state.spin.omega * 0.7 - sign * state.motion.vy * 0.04;
  state.spin.omega = Math.max(-SPIN_MAX * 1.5, Math.min(SPIN_MAX * 1.5, state.spin.omega));
}

// Throw the pet: let go of it at this speed (the app's own place for it moves, as it would if it were dragged there).
function throwIt(key, state, vx, vy) {
  const gravity = on('gravity');
  state.motion = { vx, vy, floor: false };
  state.spin = on('spin') ? { angle: 0, omega: Math.max(-SPIN_MAX, Math.min(SPIN_MAX, vx * SPIN_PER_PX)) * strength() } : null;
  state.rot = 0;
  const options = {
    vx,
    vy,
    gravity: gravity ? GRAVITY : 0,
    ...(gravity ? { friction: AIR_FRICTION } : {}),
    floorFriction: FLOOR_FRICTION,
    floorDecel: FLOOR_DECEL,
    bounce: WALL_BOUNCE,
    bounceY: FLOOR_BOUNCE,
    onFrame: ({ vx: now, vy: down, floor }) => {
      state.motion = { vx: now, vy: down, floor: !!floor, floorAt: floor ? performance.now() : state.motion?.floorAt };
      if (state.spin) return startTurning();
      // turning off, it leans the way it goes, swinging on the same spring
      const target = Math.max(-TILT_MAX, Math.min(TILT_MAX, now * TILT_PER_PX)) * strength();
      state.speed = (state.speed + (target - state.tilt) * SPRING) * DAMPING;
      state.tilt += state.speed;
      state.rot = state.tilt;
      paint(key, state);
    },
    onBump: ({ axis, side }) => {
      rub(state, axis, side);
      set(key, state, axis === 'x' ? 'bump-x' : 'bump-y');
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        if (state.glide) set(key, state, 'fly');
      }, BUMP_MS);
    },
    onEnd: ({ why }) => {
      state.glide = null;
      if (why === 'grabbed') return;
      if (state.spin) {
        set(key, state, 'roll');                                     // it rights itself, and the turning ends it
        startTurning();
      } else {
        state.rot = 0;
        set(key, state, 'bounce', BOUNCE_MS);
      }
    },
  };
  state.glide = key === 'me' ? mod.app.pet.glide(options) : mod.app.members.glide(key, options);
  if (state.glide) {
    set(key, state, 'fly');
    if (state.spin) startTurning();
  } else {
    state.spin = null;
  }
  return !!state.glide;
}

function handle(key, event) {
  let state = states.get(key);
  if (!state) states.set(key, state = { mode: '', tilt: 0, speed: 0, rot: 0, spin: null, motion: null, glide: null, timer: null });
  if (event.type === 'press') {
    state.glide?.stop();
    state.glide = null;
    state.tilt = 0;
    state.speed = 0;
    set(key, state, on('press') ? 'down' : '');
    if (state.spin) startTurning();                                  // a pet that was turning is turned upright in the hand
  } else if (event.type === 'dragstart') {
    set(key, state, on('drag') ? 'drag' : '');
  } else if (event.type === 'drag') {
    // The swing is a spring pulled towards the way the pet is being pulled, and it overshoots and comes back.
    const target = Math.max(-TILT_MAX, Math.min(TILT_MAX, event.vx * TILT_PER_PX)) * strength();
    state.speed = (state.speed + (target - state.tilt) * SPRING) * DAMPING;
    state.tilt += state.speed;
    if (state.mode === 'drag') paint(key, state);
  } else if (event.type === 'release') {
    // The same speed for every pet: the hand's, as the loader measured it at the moment of letting go.
    const vx = Number(event.vx) || 0;
    const vy = Number(event.vy) || 0;
    const click = !event.moved && event.heldMs <= CLICK_MS;
    const speed = Math.hypot(vx, vy);
    if (!click && event.moved && speed >= THROW_MIN && on('throw')) {
      const scale = Math.min(1, THROW_MAX / speed);
      if (throwIt(key, state, vx * scale, vy * scale)) return;
    }
    set(key, state, on(click ? 'click' : 'release') ? (click ? 'pop' : 'bounce') : '', BOUNCE_MS);
  }
}

if (!mod.app?.pet?.onInteraction) {
  mod.log('这个版本的加载器没有桌宠的互动事件，请先更新加载器');
} else {
  mod.css(CSS);
  mod.app.pet.onInteraction(event => handle('me', event));
  mod.app.members.onInteraction(event => handle(String(event.id), event));
}

mod.onDispose(() => {
  cancelAnimationFrame(turning);
  turning = 0;
  for (const [key, state] of states) {
    state.glide?.stop();
    state.spin = null;
    clearTimeout(state.timer);
    const element = elementOf(key);
    element?.removeAttribute('data-wf');
    element?.style.removeProperty('--wf-k');
    element?.style.removeProperty('--wf-tilt');
    element?.style.removeProperty('--wf-rot');
  }
  states.clear();
});
