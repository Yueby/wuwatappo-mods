// Pet position, the page half: one button in the plugin's settings dialog, "take the place the pet is at now".
// The pet is in the main window, which is the one that knows where it is; this only says so, through
// localStorage (every window shares it), and main.js answers by remembering the place.

const NOW_KEY = 'modkit-pet-position-now';

const remove = mod.entry({
  title: '记下现在的位置',
  description: '把桌宠现在所在的位置记作要保住的位置（平时拖一下桌宠就会自动记住）',
  button: {
    label: '记下',
    onClick: () => {
      localStorage.setItem(NOW_KEY, String(Date.now()));
    },
  },
});

mod.onDispose(() => {
  remove();
  localStorage.removeItem(NOW_KEY);
});
