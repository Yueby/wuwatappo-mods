// Bubble pop: the emote bubbles a pet sends out (the person's own, and every other player's, which are drawn by the same
// rule) come out springy. The app lets a bubble rise and fade over one second; this keeps that second and the place it
// ends, and changes how it goes: it starts small at the pet's head, swells past its size (squashed wide, then stretched
// tall), springs back a few times, sways a little as it floats up, and fades while it shrinks.
//
// It is one animation on the bubble, with the app's own name for the bubble's rule as what it replaces and the app's own
// length for its time: the app takes a bubble of its own away when the animation of it ends (`animationend`, which
// bubbles up from anything inside it), so a second animation, even on the picture, would end the bubble early. The
// strength is a variable on the page (`--wb-k`) that the keyframes multiply by.

const NAME = 'wb-bubble-pop';

const keyframes = `
@keyframes ${NAME} {
  0%   { opacity: 0; transform: translate(-50%, calc(-30% + 16px)) scale(.12, .12) rotate(calc(-16deg * var(--wb-k, 1))); }
  12%  { opacity: 1; transform: translate(-50%, calc(-30% - var(--bubble-rise, 102px) * .10)) scale(calc(1 + .30 * var(--wb-k, 1)), calc(1 - .22 * var(--wb-k, 1))) rotate(calc(9deg * var(--wb-k, 1))); }
  24%  { transform: translate(-50%, calc(-30% - var(--bubble-rise, 102px) * .20)) scale(calc(1 - .16 * var(--wb-k, 1)), calc(1 + .22 * var(--wb-k, 1))) rotate(calc(-7deg * var(--wb-k, 1))); }
  36%  { transform: translate(-50%, calc(-30% - var(--bubble-rise, 102px) * .30)) scale(calc(1 + .09 * var(--wb-k, 1)), calc(1 - .07 * var(--wb-k, 1))) rotate(calc(4deg * var(--wb-k, 1))); }
  48%  { transform: translate(-50%, calc(-30% - var(--bubble-rise, 102px) * .40)) scale(calc(1 - .04 * var(--wb-k, 1)), calc(1 + .05 * var(--wb-k, 1))) rotate(calc(-3deg * var(--wb-k, 1))); }
  60%  { opacity: 1; transform: translate(-50%, calc(-30% - var(--bubble-rise, 102px) * .52)) scale(1, 1) rotate(calc(2deg * var(--wb-k, 1))); }
  78%  { opacity: 1; transform: translate(-50%, calc(-30% - var(--bubble-rise, 102px) * .78)) scale(1, 1) rotate(calc(-2deg * var(--wb-k, 1))); }
  100% { opacity: 0; transform: translate(-50%, calc(-30% - var(--bubble-rise, 102px))) scale(.9, .9) rotate(0deg); }
}
@media (prefers-reduced-motion: reduce) {
  .local-emotion-bubble { animation-name: local-emotion-float-up !important; }
}`;

const strength = () => {
  const value = Number(mod.config.get('strength'));
  return Number.isFinite(value) ? Math.min(2, Math.max(0.5, value)) : 1;
};

const apply = () => document.documentElement.style.setProperty('--wb-k', String(strength()));

// The same length (1 s), the same end (`forwards`): only the name of the keyframes is another.
mod.css(`${keyframes}
.local-emotion-bubble { animation-name: ${NAME}; animation-timing-function: linear; transform-origin: 50% 70%; }`);
apply();
mod.config.onChange('strength', apply);
mod.onDispose(() => document.documentElement.style.removeProperty('--wb-k'));
