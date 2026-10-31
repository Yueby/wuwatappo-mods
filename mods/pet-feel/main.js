// Pet feel: springy motion for what the person does to a pet, the person's own and every other player's. Pressing it
// squashes the body down, lifting it (a drag) picks it up by the head so that it dangles and swings the way it is
// pulled, letting go drops it with a few bounces, and a quick press and release (a click) makes it jump and land.
// Let go while it is being pulled fast, and it is thrown: it goes on with that speed, slows down, bounces off the edges
// of the screen (squashing against them), and lands where it stops, which is its place from then on.
//
// What the person does is told by the app (`mod.app.pet.onInteraction`, `mod.app.members.onInteraction`: whether the
// pet is held and whether it has moved while held, looked at once a frame), not guessed from the mouse. The motion is
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
const THROW_MIN = 480;            // px a second: let go slower than this and it is only put down
const THROW_MAX = 4200;           // and it is not thrown faster than this
const BUMP_MS = 300;              // how long the squash against an edge is looked after

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
[data-wf="down"] ${BODY} { transform: scale(calc(1 + .10 * var(--wf-k, 1)), calc(1 - .16 * var(--wf-k, 1))); transition: transform 130ms ${EASE_SPRING}; }
[data-wf="drag"] ${BODY} { transform-origin: 50% 12%; animation: wf-dangle 520ms ease-in-out infinite alternate; filter: drop-shadow(0 calc(14px * var(--wf-k, 1)) calc(8px * var(--wf-k, 1)) rgba(90, 50, 20, .30)); }
[data-wf="fly"] ${BODY} { transform-origin: 50% 60%; transform: scale(calc(1 + .05 * var(--wf-k, 1))) rotate(calc(var(--wf-tilt, 0) * 1deg)); filter: drop-shadow(0 calc(12px * var(--wf-k, 1)) calc(8px * var(--wf-k, 1)) rgba(90, 50, 20, .26)); transition: transform 80ms linear; }
[data-wf="bump-x"] ${BODY} { animation: wf-bump-x ${BUMP_MS}ms ease-out; }
[data-wf="bump-y"] ${BODY} { animation: wf-bump-y ${BUMP_MS}ms ease-out; }
[data-wf="bounce"] ${BODY} { animation: wf-bounce ${BOUNCE_MS}ms ease-out; }
[data-wf="pop"] ${BODY} { animation: wf-pop 560ms ease-out; }
@media (prefers-reduced-motion: reduce) {
  [data-wf] ${BODY} { transform: none; animation: none; filter: none; transition: none; }
}
`;

const strength = () => {
  const value = Number(mod.config.get('strength'));
  return Number.isFinite(value) ? Math.min(2, Math.max(0.5, value)) : 1;
};

// What each pet is doing: 'me' or a player's id -> { mode, tilt, speed, vx, vy, glide, timer }.
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

// Throw the pet: let go of it at this speed (the app's own place for it moves, as it would if it were dragged there).
function throwIt(key, state, vx, vy) {
  const options = {
    vx,
    vy,
    // while it flies it leans the way it goes, swinging on the same spring
    onFrame: ({ vx: now }) => {
      const target = Math.max(-TILT_MAX, Math.min(TILT_MAX, now * TILT_PER_PX)) * strength();
      state.speed = (state.speed + (target - state.tilt) * SPRING) * DAMPING;
      state.tilt += state.speed;
      paint(key, state);
    },
    onBump: ({ axis }) => {
      set(key, state, axis === 'x' ? 'bump-x' : 'bump-y');
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        if (state.glide) set(key, state, 'fly');
      }, BUMP_MS);
    },
    onEnd: ({ why }) => {
      state.glide = null;
      if (why !== 'grabbed') set(key, state, 'bounce', BOUNCE_MS);
    },
  };
  state.glide = key === 'me' ? mod.app.pet.glide(options) : mod.app.members.glide(key, options);
  if (state.glide) set(key, state, 'fly');
  return !!state.glide;
}

function handle(key, event) {
  let state = states.get(key);
  if (!state) states.set(key, state = { mode: '', tilt: 0, speed: 0, vx: 0, vy: 0, glide: null, timer: null });
  if (event.type === 'press') {
    state.glide?.stop();
    state.glide = null;
    state.tilt = 0;
    state.speed = 0;
    state.vx = 0;
    state.vy = 0;
    set(key, state, 'down');
  } else if (event.type === 'dragstart') {
    set(key, state, 'drag');
  } else if (event.type === 'drag') {
    // The swing is a spring pulled towards the way the pet is being pulled, and it overshoots and comes back.
    const target = Math.max(-TILT_MAX, Math.min(TILT_MAX, event.vx * TILT_PER_PX)) * strength();
    state.speed = (state.speed + (target - state.tilt) * SPRING) * DAMPING;
    state.tilt += state.speed;
    state.vx = state.vx * 0.5 + event.vx * 0.5;                      // and how fast it is going, over the last few frames
    state.vy = state.vy * 0.5 + event.vy * 0.5;
    paint(key, state);
  } else if (event.type === 'release') {
    const click = !event.moved && event.heldMs <= CLICK_MS;
    const speed = Math.hypot(state.vx, state.vy);
    if (!click && event.moved && speed >= THROW_MIN) {
      const scale = Math.min(1, THROW_MAX / speed);
      if (throwIt(key, state, state.vx * scale, state.vy * scale)) return;
    }
    set(key, state, click ? 'pop' : 'bounce', BOUNCE_MS);
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
  for (const [key, state] of states) {
    state.glide?.stop();
    clearTimeout(state.timer);
    const element = elementOf(key);
    element?.removeAttribute('data-wf');
    element?.style.removeProperty('--wf-k');
    element?.style.removeProperty('--wf-tilt');
  }
  states.clear();
});
