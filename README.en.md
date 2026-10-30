# Wuwa Tappo plugin registry

[中文](README.md) · English

The plugin registry for the [Wuwa Tappo plugin loader](https://github.com/Yueby/wuwatappo-modkit). The launcher lists what is here and installs it with one press, with no download by hand.

## Plugins

| Plugin | What it does | Default | What it declares |
|---|---|---|---|
| **自动点击** (Auto click) | Clicks the pet at the interval set, raising the click count. In a room, the people in the room see every click | off | nothing |
| **自动开箱子** (Auto chest) | Opens a chest when it is ready (opening costs clicks). The upper and the lower chest are switched separately | off | nothing |
| **房间历史** (Room history) | Records who comes into and leaves a room, with the room number, the time and how long each person stayed. Kept on this computer only; shown on the 联机 page, from where a room can be entered again | on | the clipboard (only when 复制 is pressed, to write the room number); adding to the app's pages (the 联机 page); sending the app a command (when 进入 is pressed) |
| **背包导出** (Bag export) | Adds an "导出" button to the corner of the 背包 and 图鉴 pages: what is owned, how far the collection is and what is missing, copied as a list or saved as a text file or a table (CSV) | on | the clipboard (only when 复制清单 is pressed); adding to the app's pages; reading the app's data (the items of the bag and the atlas, to make the list) |
| **记住桌宠位置** (Pet position) | Remembers where your pet, and each other player's pet in the room, was last dragged to; when a restart or a room moves them, sets them back | on | read and change the app's own state (only used to set the pets' places) |

Plugins that act on the account are off after they are installed; they are switched on on the MOD page. How each is used is in [the loader's README](https://github.com/Yueby/wuwatappo-modkit/blob/main/README.en.md#how-each-plugin-is-used).

## Installing

Install the loader first (see [its README](https://github.com/Yueby/wuwatappo-modkit/blob/main/README.en.md#installing)), then either:

- on the **MOD** page of the app's settings panel, press **安装** at the top right; or
- in the launcher window, press **插件…**.

Select a plugin, read what it declares, and press **安装**. It takes effect at once, with no restart of the app. When there is a newer version the button reads **更新**.

## Safety

Every plugin here is looked at by hand before it is merged; what is looked for is in [CONTRIBUTING.md](CONTRIBUTING.md). But **a plugin is somebody else's code, and can do whatever the app's windows can** (one with a background program can also read files and use the network). So:

- before installing, the launcher shows what the plugin declares, whether it has a background program, and asks;
- a released version is never replaced, a change is always a new version; what is downloaded is checked against the checksum the registry lists, and thrown away if it does not match;
- only install plugins that can be trusted. A plugin that turns out to do something it did not say should be reported in Issues, and is taken out of the registry.

## What is here

```
mods/<id>/            one folder per plugin: package.json, its scripts
tests/                the plugins' tests (run against a stand-in for the app, never an account)
scripts/build.mjs     checks every plugin, packs each version, writes the index (the workflows run it)
.github/workflows/    validate (pull requests) and publish (after a merge)
```

After a merge, automation makes a release `<id>-v<version>` for each plugin version that has none, with the plugin as a zip, and replaces `index.json` on the release called `index`. That file is what the launcher reads: for each plugin its name, version, what it declares, where its zip is and the zip's SHA-256.

---

# Contributing: sending a plugin

1. Fork, add `mods/<id>/` (the folder name is the plugin's id: letters, digits, `.`, `_`, `-`), open a pull request.
2. A plugin is a folder with a `package.json` the way [docs/MODDING.md](https://github.com/Yueby/wuwatappo-modkit/blob/main/docs/MODDING.md) of the loader describes. The registry also needs `version` (like `1.0.0`) and `description` (what the list shows), and no `node_modules` (list `dependencies` instead; they are fetched when it is installed).
3. The `validate` check runs the launcher's own reader over it. Run the same yourself: `modkit.exe mods check mods\<id> --registry`.
4. Changing a plugin means raising its `version` in the same pull request.

A plugin comes with a test when it does something that needs one (`tests/`, run by `npm test`, against a stand-in for the app, never a real account). What a reviewer looks for is in [CONTRIBUTING.md](CONTRIBUTING.md): read it before writing the plugin, not after. What a plugin shows to the player is written as labels and statements, without 我 / 您 / 他 and the like.
