# wuwatappo-mods

The plugin registry for [wuwatappo-modkit](https://github.com/Yueby/wuwatappo-modkit), the mod loader for
Wuwa Tappo. The launcher lists what is here and installs it for you (the 插件 window of the launcher, and the
安装 button on the MOD page of the app's settings); you can also unpack a plugin's folder into `mods\` by hand.

Plugins here are reviewed by hand before they are merged, but **a plugin is somebody's code running with the
rights of your account** (a plugin with a Node part can read your files and use the network; a page script runs
inside the app's windows). The launcher shows what a plugin declares and asks before it installs one.

## What is here

```
mods/<id>/            one folder per plugin: package.json, its scripts
scripts/build.mjs     checks every plugin, packs each version, writes the index (the workflows run it)
.github/workflows/    validate (pull requests) and publish (after a merge)
```

After a merge, automation makes a release `<id>-v<version>` for each plugin version that has none, with the
plugin as a zip, and replaces `index.json` on the release called `index`. That file is what the launcher reads:
for each plugin its name, version, what it declares, where its zip is and the zip's SHA-256. A zip that does not
match is thrown away. A released version is never replaced; a fix is a new version.

## Sending a plugin

1. Fork, add `mods/<id>/` (the folder name is the plugin's id: letters, digits, `.`, `_`, `-`), open a pull request.
2. A plugin is a folder with a `package.json` the way [docs/MODDING.md](https://github.com/Yueby/wuwatappo-modkit/blob/main/docs/MODDING.md)
   describes. The registry also needs `version` (like `1.0.0`) and `description` (what the list shows), and no
   `node_modules` (list `dependencies` instead; they are fetched when it is installed).
3. The `validate` check runs the launcher's own reader over it. Run the same yourself:
   `modkit.exe mods check mods\<id> --registry`
4. Changing a plugin means raising its `version` in the same pull request.

What a reviewer looks for is in [CONTRIBUTING.md](CONTRIBUTING.md). Read it before you write the plugin, not after.
