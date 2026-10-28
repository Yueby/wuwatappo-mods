# What a plugin has to be to get in

Every plugin is read by a person before it is merged. This is what that person looks for, so you know what to
write and what to leave out.

## Honest about what it does

- `description` says what the plugin does, in a sentence. What it shows on the MOD page matches what it does.
- `modkit.permissions` lists what it uses. Use these words, which people are shown in plain Chinese: `files` (读写文件),
  `network` (联网), `clipboard` (读写剪贴板), `run` (运行其他程序); any other word is shown as written. Nothing enforces it, so it is checked
  against the code: a plugin that talks to the network and does not say so is not merged.
- A plugin that sends anything off the machine says to whom and what, in its description.

## Nothing that acts on the account unless the person turns it on

- Anything that clicks, sends, buys, opens, claims or otherwise acts as the player is **off by default** and
  stays off after a restart (`"persist": false` on its switch), so it is never running because of something
  that was set up long ago. The person turns it on, knowing.
- It does not read or send the login, tokens, cookies or anything of the account's.

## Readable

- The source that runs is the source that is reviewed: no minified, bundled or obfuscated code without the
  source it was built from in the same pull request (and a build that reproduces it).
- A Node part (`modkit.host`) gets a closer look than a page script: it runs as ordinary Node with the rights of
  the account. It does what its description says and nothing else; it does not start other programs, download
  and run code, or write outside its own folder (`host.dataDir`) without saying so.
- Dependencies are listed in `package.json` (not committed as `node_modules`), few, and ones people know. Their
  install scripts are not run when a plugin is installed.

## Behaves

- It removes what it added when it is turned off or unloaded (`mod.onDispose`), and does not keep a timer or
  a listener running after.
- It does not break the app's own pages: it uses the app's styles for anything it shows (see MODDING.md).
- It declares the other plugins it needs (`modkit.requires`) instead of assuming them.

## Versions

- A released version is never replaced. A change, even of one character, is a new `version` in the same pull
  request, and the check refuses a pull request that does not have one.
- Versions are numbers: `1.0.0`, `1.0.1`, `1.1.0`.

## Taking one out

A plugin that turns out to do what it did not say is removed from `mods/` and so from the index; it is not
listed any more, and the launcher's update does not offer it. People who have it keep it until they remove it.
