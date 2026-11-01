// Pet position, the page half: one button in the plugin's settings dialog, "take the place the pet is at now".
// The pet is in the main window, which is the one that knows where it is; this only says so, through
// localStorage (every window shares it), and main.js answers by remembering the place.

const NOW_KEY = 'modkit-pet-position-now';

const remove = mod.entry({
  title: '记录当前位置',
  description: '把当前所有桌宠的位置记为要保持的位置。拖动桌宠时会自动记录。',
  button: {
    label: '记录',
    onClick: () => {
      localStorage.setItem(NOW_KEY, String(Date.now()));
    },
  },
});

mod.onDispose(() => {
  remove();
  localStorage.removeItem(NOW_KEY);
});
