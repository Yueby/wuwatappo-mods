// Bag export: a button on the 背包 and 图鉴 pages of the app's panel that gives what the page shows as a list: copied,
// or saved as a text file or a table (CSV, opens in Excel).
//
//   背包  what is owned: by kind (角色, 配件, 表情), the rarest first, with how many of each.
//   图鉴  how far the collection is: owned/total by rarity and by kind, and what is still missing.
//
// The lists are read from what the panel was given to draw the pages from (the component MainModulePanel has
// `bagList` and `atlasList`: one record for each item, with its file name and rarity but not its name). The name
// is what the app itself shows: the loader finds the app's function for it (`mod.app.assetName`); when that cannot
// be told, the file name stands in. Nothing is sent anywhere; the list goes to the clipboard or to a file on this
// computer, which the page saves like any download (the "下载" folder).

const KINDS = [['character_skin', '角色'], ['accessory', '配件'], ['emote', '表情']];
const RARITIES = ['epic', 'rare', 'uncommon', 'common'];
const RARITY_NAME = { epic: 'Epic', rare: 'Rare', uncommon: 'Uncommon', common: 'Common' };
const MESSAGE_MS = 4000;

const CSS = `
.bx-wrap { position: absolute; top: 30px; right: 104px; z-index: 20; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.bx-btn { border: 1px solid rgb(231, 183, 124); background: rgb(254, 210, 145); color: rgb(142, 94, 67); border-radius: 15px; height: 30px; padding: 0 16px; font: inherit; font-size: 16px; cursor: pointer; box-shadow: 0 2px 0 rgb(231, 183, 124); }
.bx-btn:hover { filter: brightness(1.04); }
.bx-btn:disabled { opacity: .55; cursor: default; }
.bx-menu { background: rgb(251, 237, 213); border: 1px solid rgb(231, 183, 124); border-radius: 12px; padding: 6px; display: flex; flex-direction: column; gap: 4px; min-width: 190px; box-shadow: 0 6px 16px rgba(120, 80, 50, .25); }
.bx-menu button { border: 0; background: transparent; color: rgb(142, 94, 67); font: inherit; font-size: 16px; text-align: left; padding: 6px 12px; border-radius: 8px; cursor: pointer; }
.bx-menu button:hover { background: rgb(254, 210, 145); }
.bx-note { font-size: 14px; color: rgb(142, 123, 106); background: rgb(251, 237, 213); border-radius: 10px; padding: 4px 10px; }
`;

const two = n => String(n).padStart(2, '0');
function stamp(date = new Date()) {
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
}
function whenText(date = new Date()) {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

const kindOf = type => String(type ?? '').toLowerCase().replace(/_atlas$/, '');
const kindName = kind => KINDS.find(([key]) => key === kind)?.[1] ?? kind;
const rarityRank = rarity => {
  const at = RARITIES.indexOf(String(rarity ?? '').toLowerCase());
  return at < 0 ? RARITIES.length : at;
};
const rarityText = rarity => RARITY_NAME[String(rarity ?? '').toLowerCase()] ?? String(rarity ?? '');

// The records the pages are drawn from, or null while the panel has none (not logged in, or not drawn yet).
function lists() {
  const props = mod.page.find('MainModulePanel')?.props;
  if (!props) return null;
  return { bag: Array.isArray(props.bagList) ? [...props.bagList] : [], atlas: Array.isArray(props.atlasList) ? [...props.atlasList] : [] };
}

// An item with its name, as the app shows it.
async function named(record) {
  const file = String(record.asset_name ?? '');
  let name = null;
  try {
    name = await mod.app.assetName(record.asset_type, file);
  } catch {
    name = null;
  }
  return { name: name ?? (file.replace(/\.png$/i, '') || `#${record.asset_id}`), kind: kindOf(record.asset_type), rarity: String(record.rarity ?? ''), quantity: Number(record.quantity) || 0, collected: record.is_collect === 1, id: record.asset_id, file };
}

const byRarityThenName = (a, b) => rarityRank(a.rarity) - rarityRank(b.rarity) || a.name.localeCompare(b.name, 'zh');

function bagText(items) {
  const total = items.reduce((sum, item) => sum + item.quantity, 0);
  const lines = [`背包  ${whenText()}`, `共 ${items.length} 种，合计 ${total} 件`, ''];
  for (const [kind] of KINDS) {
    const own = items.filter(item => item.kind === kind).sort(byRarityThenName);
    if (!own.length) continue;
    lines.push(`【${kindName(kind)}】${own.length} 种，${own.reduce((sum, item) => sum + item.quantity, 0)} 件`);
    for (const item of own) lines.push(`  ${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ''}  ${rarityText(item.rarity)}${item.collected ? '  已收藏' : ''}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function atlasText(all, owned) {
  const have = new Set(owned.map(record => String(record.asset_name)));       // the bag and the atlas number their items differently: the file is the same
  const rows = all.map(item => ({ ...item, has: have.has(item.file) }));
  const lines = [`图鉴  ${whenText()}`, `已有 ${rows.filter(row => row.has).length} / ${rows.length}`, ''];
  lines.push('按稀有度');
  for (const rarity of RARITIES) {
    const group = rows.filter(row => row.rarity.toLowerCase() === rarity);
    if (group.length) lines.push(`  ${rarityText(rarity)}  ${group.filter(row => row.has).length} / ${group.length}`);
  }
  lines.push('', '按类别');
  for (const [kind] of KINDS) {
    const group = rows.filter(row => row.kind === kind);
    if (group.length) lines.push(`  ${kindName(kind)}  ${group.filter(row => row.has).length} / ${group.length}`);
  }
  lines.push('', '还没有的');
  for (const [kind] of KINDS) {
    for (const rarity of RARITIES) {
      const missing = rows.filter(row => row.kind === kind && row.rarity.toLowerCase() === rarity && !row.has).sort(byRarityThenName);
      if (missing.length) lines.push(`【${kindName(kind)} · ${rarityText(rarity)}】${missing.length} 个`, `  ${missing.map(row => row.name).join('、')}`);
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

const cell = value => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const csv = (head, rows) => '﻿' + [head, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';

function bagCsv(items) {
  return csv(['类别', '名称', '稀有度', '数量', '已收藏', '文件'], [...items].sort((a, b) => KINDS.findIndex(k => k[0] === a.kind) - KINDS.findIndex(k => k[0] === b.kind) || byRarityThenName(a, b))
    .map(item => [kindName(item.kind), item.name, rarityText(item.rarity), item.quantity, item.collected ? '是' : '', item.file]));
}

function atlasCsv(all, owned) {
  const have = new Set(owned.map(record => String(record.asset_name)));
  return csv(['类别', '名称', '稀有度', '已有', '文件'], [...all].sort((a, b) => KINDS.findIndex(k => k[0] === a.kind) - KINDS.findIndex(k => k[0] === b.kind) || byRarityThenName(a, b))
    .map(item => [kindName(item.kind), item.name, rarityText(item.rarity), have.has(item.file) ? '是' : '否', item.file]));
}

// What a page gives: the list as text and as a table, or null when the panel has nothing for it yet.
async function build(kind) {
  const data = lists();
  if (!data) return null;
  if (kind === 'bag') {
    if (!data.bag.length) return null;
    const items = await Promise.all(data.bag.map(named));
    return { label: '背包', count: items.length, text: bagText(items), table: bagCsv(items) };
  }
  if (!data.atlas.length) return null;
  const all = await Promise.all(data.atlas.map(named));
  return { label: '图鉴', count: all.length, text: atlasText(all, data.bag), table: atlasCsv(all, data.bag) };
}

function save(fileName, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The control of one page: a button, and under it, when it is pressed, what it can do.
function control(kind) {
  const wrap = el('div', 'bx-wrap');
  const button = el('button', 'bx-btn', '导出');
  button.type = 'button';
  const slot = el('div');
  wrap.append(button, slot);
  let note = null;
  let timer = null;

  const say = text => {
    note?.remove();
    note = el('div', 'bx-note', text);
    wrap.append(note);
    clearTimeout(timer);
    timer = setTimeout(() => { note?.remove(); note = null; }, MESSAGE_MS);
  };
  const closeMenu = () => slot.replaceChildren();

  async function run(what) {
    closeMenu();
    button.disabled = true;
    try {
      const made = await build(kind);
      if (!made) {
        say(kind === 'bag' ? '背包里还没有东西，或者还没有登录' : '图鉴还没有读到，稍后再试');
        return;
      }
      const base = `${made.label}-${stamp()}`;
      if (what === 'copy') {
        await navigator.clipboard.writeText(made.text);
        say(`已复制，共 ${made.count} 项`);
      } else if (what === 'text') {
        save(`${base}.txt`, made.text, 'text/plain');
        say('已保存为文本，一般在“下载”文件夹里');
      } else {
        save(`${base}.csv`, made.table, 'text/csv');
        say('已保存为表格，一般在“下载”文件夹里');
      }
    } catch {
      say('没有成功，稍后再试');
    } finally {
      button.disabled = false;
    }
  }

  button.addEventListener('click', () => {
    if (slot.children.length) {
      closeMenu();
      return;
    }
    const menu = el('div', 'bx-menu');
    for (const [what, label] of [['copy', '复制清单'], ['text', '保存为文本'], ['table', '保存为表格（CSV）']]) {
      const item = el('button', '', label);
      item.type = 'button';
      item.addEventListener('click', () => run(what));
      menu.append(item);
    }
    slot.append(menu);
  });

  return { node: wrap, close: closeMenu, dispose: () => { clearTimeout(timer); wrap.remove(); } };
}

const stops = [];
stops.push(mod.css(CSS));
for (const [component, kind] of [['MainPanelBagTab', 'bag'], ['MainPanelAtlasTab', 'atlas']]) {
  stops.push(mod.page.onComponent(component, () => {
    const made = control(kind);
    const remove = mod.page.mount('.module-content', made.node);
    return () => {
      remove();
      made.dispose();
    };
  }));
}
mod.onDispose(() => stops.forEach(stop => stop()));
