// mods/bag-export, run against a stand-in for the panel: the page's components (what `mod.page` gives), the records the
// panel draws the bag and the atlas from, the app's names for items, the clipboard, and what a download is. Nothing
// here touches the real app or an account.
//
//   node --test tests/bag-export.test.js

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const folder = path.join(import.meta.dirname, '..', 'mods', 'bag-export');
const source = await fs.readFile(path.join(folder, 'panel.js'), 'utf8');
const manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const running = [];
after(() => running.forEach(run => run.dispose()));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeElement(tag) {
  return {
    tag, className: '', textContent: '', disabled: false, type: '', href: '', download: '', children: [], handlers: [],
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    remove() { this.removed = true; },
    addEventListener(type, fn) { if (type === 'click') this.handlers.push(fn); },
    press() { return Promise.all(this.handlers.map(fn => fn())); },
    click() { this.clicked = true; },
    all() { return [this, ...this.children.flatMap(child => child.all?.() ?? [])]; },
    find(predicate) { return this.all().filter(predicate); },
  };
}

// What the panel has: the items of the bag (a record each, with the file and the rarity but no name) and of the atlas.
const record = (id, type, file, rarity, quantity, extra = {}) => ({ asset_id: id, asset_type: type, asset_name: file, rarity, quantity, is_collect: 0, ...extra });
const BAG = [
  record(1975, 'emote', 'emote_1610_happy.png', 'common', 2),
  record(404, 'character_skin', 'role_1207_1003.png', 'uncommon', 1, { is_collect: 1 }),
  record(500, 'accessory', 'accessory_1005.png', 'rare', 1),
  record(501, 'character_skin', 'role_1501_1001.png', 'common', 1),
];
const ATLAS = [
  record(2001, 'emote_atlas', 'emote_1610_happy.png', 'common', 0),
  record(2002, 'emote_atlas', 'emote_1610_sad.png', 'common', 0),
  record(2003, 'character_skin_atlas', 'role_1207_1003.png', 'uncommon', 0),
  record(2004, 'character_skin_atlas', 'role_1501_1001.png', 'common', 0),
  record(2005, 'character_skin_atlas', 'role_1999_1009.png', 'epic', 0),
  record(2006, 'accessory_atlas', 'accessory_1005.png', 'rare', 0),
  record(2007, 'accessory_atlas', 'accessory_1006.png', 'rare', 0),
];
const NAMES = {
  'emote_1610_happy.png': '秧秧・玄翎・开心', 'emote_1610_sad.png': '秧秧・玄翎・难过', 'role_1207_1003.png': '露帕・ARE', 'role_1501_1001.png': '漂泊者・经典',
  'role_1999_1009.png': '桃夭灼灼', 'accessory_1005.png': '影烁者', 'accessory_1006.png': '无冠者',
};

function load({ bag = BAG, atlas = ATLAS, names = NAMES, panelProps = true, clipboard = { writes: [], fails: false } } = {}) {
  const watchers = [];
  const mounts = [];
  const removed = [];
  const sheets = [];
  const downloads = [];
  const disposers = [];
  const mod = {
    css: text => { sheets.push(text); return () => sheets.splice(sheets.indexOf(text), 1); },
    onDispose: fn => { disposers.push(fn); },
    app: { assetName: async (type, file) => names[file] ?? null },
    page: {
      find: name => (name === 'MainModulePanel' && panelProps ? { name, el: {}, props: { bagList: bag, atlasList: atlas } } : null),
      onComponent(name, fn) {
        const watcher = { name, fn, cleanup: null };
        watchers.push(watcher);
        return () => { watcher.cleanup?.(); watcher.cleanup = null; };
      },
      mount(target, node) { mounts.push({ target, node }); return () => removed.push(target); },
    },
  };
  const document = {
    createElement: tag => fakeElement(tag),
    body: { append: node => { if (node.tag === 'a') downloads.push(node); } },
  };
  const URLStub = { createObjectURL: blob => { URLStub.blobs.push(blob); return `blob:${URLStub.blobs.length}`; }, revokeObjectURL() {}, blobs: [] };
  const navigator = { clipboard: { writeText: text => { clipboard.writes.push(text); return clipboard.fails ? Promise.reject(new Error('no')) : Promise.resolve(); } } };
  new AsyncFunction('mod', 'document', 'URL', 'navigator', source)(mod, document, URLStub, navigator);
  const run = {
    watchers, mounts, removed, sheets, downloads, blobs: URLStub.blobs, clipboard,
    dispose: () => disposers.forEach(fn => fn()),
    // the app draws a page: its component appears
    appears(name) { const watcher = watchers.find(w => w.name === name); watcher.cleanup = watcher.fn({ name, el: {}, props: {} }); return mounts.at(-1).node; },
    // the person presses the button of a control, then an entry of its menu
    async choose(control, label) {
      const [button, slot] = control.children;
      await button.press();
      const entry = slot.find(node => node.tag === 'button' && node.textContent === label)[0];
      assert.ok(entry, `the menu has "${label}"`);
      await entry.press();
      await sleep(10);
    },
    note: control => control.children.find(node => node.className === 'bx-note')?.textContent ?? null,
  };
  running.push(run);
  return run;
}

test('what it declares: the panel only, no network, and the permissions that say what it does', () => {
  assert.deepEqual(manifest.modkit.windows, { panel: 'panel.js' });
  assert.equal(manifest.modkit.api, 5);
  assert.deepEqual(manifest.modkit.permissions, ['clipboard', 'page', 'app-state']);
  const code = source.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  assert.ok(!/fetch\(|XMLHttpRequest|new WebSocket|sendBeacon/.test(code), 'it sends nothing anywhere');
  const strings = [...code.matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)].map(m => m[1] ?? m[2]).filter(text => /[一-鿿]/.test(text));
  for (const text of [manifest.description, manifest.displayName, ...strings]) assert.ok(!/[我咱您你她]|(?<!其)他/.test(text), `a person word in "${text}"`);
});

test('a control is put on the bag page and on the atlas page when each is drawn, and taken away with it', () => {
  const run = load();
  assert.deepEqual(run.watchers.map(w => w.name), ['MainPanelBagTab', 'MainPanelAtlasTab']);
  assert.equal(run.mounts.length, 0, 'nothing until a page is drawn');
  const control = run.appears('MainPanelBagTab');
  assert.equal(control.className, 'bx-wrap');
  assert.equal(run.mounts[0].target, '.module-content', 'into the page\'s content, over its corner');
  assert.equal(control.children[0].textContent, '导出');
  assert.match(run.sheets.join(''), /\.bx-wrap/);
  run.watchers[0].cleanup();
  assert.equal(run.removed.length, 1);
  assert.equal(control.removed, true);
  run.dispose();
});

test('the button opens a menu of three, and pressing it again closes it', async () => {
  const run = load();
  const control = run.appears('MainPanelBagTab');
  const [button, slot] = control.children;
  await button.press();
  assert.deepEqual(slot.children[0].children.map(node => node.textContent), ['复制清单', '保存为文本', '保存为表格（CSV）']);
  await button.press();
  assert.equal(slot.children.length, 0);
});

test('the bag is copied as a list: by kind, the rarest first, with how many, and the name the app shows', async () => {
  const run = load();
  await run.choose(run.appears('MainPanelBagTab'), '复制清单');
  const text = run.clipboard.writes.at(-1);
  const lines = text.split('\n');
  assert.match(lines[0], /^背包  \d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.equal(lines[1], '共 4 种，合计 5 件');
  assert.deepEqual(lines.slice(3), [
    '【角色】2 种，2 件',
    '  露帕・ARE  Uncommon  已收藏',
    '  漂泊者・经典  Common',
    '',
    '【配件】1 种，1 件',
    '  影烁者  Rare',
    '',
    '【表情】1 种，2 件',
    '  秧秧・玄翎・开心 ×2  Common',
    '',
  ]);
});

test('an item the app has no name for is listed by its file, and a bag with nothing in it says so', async () => {
  const run = load({ names: {} });
  await run.choose(run.appears('MainPanelBagTab'), '复制清单');
  assert.match(run.clipboard.writes.at(-1), /emote_1610_happy ×2/);

  const empty = load({ bag: [] });
  const control = empty.appears('MainPanelBagTab');
  await empty.choose(control, '复制清单');
  assert.equal(empty.clipboard.writes.length, 0);
  assert.equal(empty.note(control), '背包里还没有东西，或者还没有登录');
});

test('the atlas is copied as how far it is: by rarity and by kind, and what is missing, with the bag told from the atlas by the file', async () => {
  const run = load();
  await run.choose(run.appears('MainPanelAtlasTab'), '复制清单');
  const text = run.clipboard.writes.at(-1);
  assert.match(text, /已有 4 \/ 7/, 'four of the seven are in the bag (the bag and the atlas number their items differently)');
  assert.match(text, /  Epic  0 \/ 1\n  Rare  1 \/ 2\n  Uncommon  1 \/ 1\n  Common  2 \/ 3/);
  assert.match(text, /  角色  2 \/ 3\n  配件  1 \/ 2\n  表情  1 \/ 2/);
  assert.match(text, /【角色 · Epic】1 个\n  桃夭灼灼/);
  assert.match(text, /【配件 · Rare】1 个\n  无冠者/);
  assert.match(text, /【表情 · Common】1 个\n  秧秧・玄翎・难过/);
  assert.ok(!/【角色 · Common】/.test(text), 'nothing of what is owned is listed as missing');
});

test('saving: a text file and a table, named for the page and the time, and the table opens in Excel', async () => {
  const run = load();
  const control = run.appears('MainPanelBagTab');
  await run.choose(control, '保存为文本');
  assert.match(run.downloads.at(-1).download, /^背包-\d{8}-\d{4}\.txt$/);
  assert.equal(run.downloads.at(-1).clicked, true);
  assert.equal(run.downloads.at(-1).removed, true, 'the link is not left in the page');
  assert.match(await run.blobs.at(-1).text(), /露帕・ARE/);
  assert.equal(run.note(control), '已保存为文本，一般在“下载”文件夹里');

  await run.choose(control, '保存为表格（CSV）');
  assert.match(run.downloads.at(-1).download, /\.csv$/);
  const table = await run.blobs.at(-1).text();
  assert.deepEqual([...new Uint8Array(await run.blobs.at(-1).arrayBuffer()).slice(0, 3)], [0xEF, 0xBB, 0xBF], 'with the mark that Excel reads UTF-8 by');       // (reading it as text takes the mark off)
  assert.deepEqual(table.split('\r\n').slice(0, 3), ['类别,名称,稀有度,数量,已收藏,文件', '角色,露帕・ARE,Uncommon,1,是,role_1207_1003.png', '角色,漂泊者・经典,Common,1,,role_1501_1001.png']);
});

test('a name with a comma or a quote is quoted in the table', async () => {
  const run = load({ names: { ...NAMES, 'accessory_1005.png': '带"引号",和逗号' } });
  await run.choose(run.appears('MainPanelBagTab'), '保存为表格（CSV）');
  assert.match(await run.blobs.at(-1).text(), /"带""引号"",和逗号"/);
});

test('the atlas table says for each item whether it is owned', async () => {
  const run = load();
  await run.choose(run.appears('MainPanelAtlasTab'), '保存为表格（CSV）');
  const rows = (await run.blobs.at(-1).text()).split('\r\n');
  assert.equal(rows[0], '类别,名称,稀有度,已有,文件');
  assert.ok(rows.includes('角色,桃夭灼灼,Epic,否,role_1999_1009.png'));
  assert.ok(rows.includes('角色,露帕・ARE,Uncommon,是,role_1207_1003.png'));
});

test('when the clipboard refuses, or the panel has no records yet, it says so and does not break', async () => {
  const refused = load({ clipboard: { writes: [], fails: true } });
  const control = refused.appears('MainPanelBagTab');
  await refused.choose(control, '复制清单');
  assert.equal(refused.note(control), '没有成功，稍后再试');
  assert.equal(control.children[0].disabled, false, 'the button is usable again');

  const nothing = load({ panelProps: false });
  const c2 = nothing.appears('MainPanelAtlasTab');
  await nothing.choose(c2, '复制清单');
  assert.equal(nothing.note(c2), '图鉴还没有读到，稍后再试');
});
