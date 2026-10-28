// The registry's automation: check every plugin, pack each version, write the index.
//
//   node scripts/build.mjs                    check, pack into dist/, write dist/index.json. Publishes nothing.
//   node scripts/build.mjs --base origin/main also: a plugin whose files differ from <base> must have a
//                                             version that <base> did not have (what a pull request is held to)
//   node scripts/build.mjs --publish          also: a release for each version that has none yet
//                                             (tag <id>-v<version>, the zip as its asset), and index.json as the
//                                             asset of the release called "index"
//
// It needs the program the plugins are for, to read their manifests the way it will: MODKIT_EXE, the
// modkit.exe of a release of wuwatappo-modkit (the workflows download and verify one). While writing
// this, `MODKIT_EXE=node MODKIT_ARGS=<path to modkit's src/cli.js>` does the same from a checkout.
//
// No dependencies: it uses git, gh and tar, which a Windows runner has.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const repo = process.env.GITHUB_REPOSITORY ?? 'Yueby/wuwatappo-mods';
const args = process.argv.slice(2);
const publish = args.includes('--publish');
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;

const problems = [];
const say = text => console.log(text);

function modkit(...rest) {
  if (!process.env.MODKIT_EXE) throw new Error('MODKIT_EXE is not set: it is the modkit.exe the plugins are checked with');
  const prefix = process.env.MODKIT_ARGS ? [process.env.MODKIT_ARGS] : [];
  const result = spawnSync(process.env.MODKIT_EXE, [...prefix, ...rest], { encoding: 'utf8', cwd: root });
  if (result.error) throw result.error;
  return result;
}

const git = (...rest) => spawnSync('git', rest, { encoding: 'utf8', cwd: root });
const gh = (...rest) => spawnSync('gh', rest, { encoding: 'utf8', cwd: root });
// Windows' own tar (bsdtar) writes zip; the tar on PATH may be GNU's, which does not and reads `E:` as a host.
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// --- what is there ---------------------------------------------------------------------------------

const ids = fs.readdirSync(path.join(root, 'mods'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !/^[._]/.test(entry.name))
  .map(entry => entry.name)
  .sort();
say(`${ids.length} plugin(s): ${ids.join(', ') || '(none)'}`);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const entries = [];

for (const id of ids) {
  const folder = path.join(root, 'mods', id);

  // 1. Can it be loaded, and does it have what the registry needs (a version, a description).
  const checked = modkit('mods', 'check', folder, '--registry', '--json');
  let result;
  try {
    result = JSON.parse(checked.stdout.trim().split('\n').at(-1));
  } catch {
    problems.push(`${id}: the check did not answer: ${checked.stderr || checked.stdout}`);
    continue;
  }
  if (!result.ok) {
    for (const problem of result.problems) problems.push(`${id}: ${problem}`);
    continue;
  }

  const raw = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  const tag = `${id}-v${result.version}`;
  const asset = `${id}-${result.version}.zip`;

  // 2. A change has to come with a new version, or anyone who has this one would never get it.
  if (base) {
    const changed = git('diff', '--name-only', `${base}...HEAD`, '--', `mods/${id}`).stdout.trim();
    const before = git('show', `${base}:mods/${id}/package.json`);
    if (changed && before.status === 0 && JSON.parse(before.stdout).version === result.version) {
      problems.push(`${id}: its files changed but its version is still ${result.version}: raise it, a released version is never replaced`);
    }
  }

  // 3. Pack it: the files of the folder, at the top of the zip.
  const zip = path.join(dist, asset);
  execFileSync(tar, ['-a', '-cf', zip, '-C', folder, '.']);
  let bytes = fs.readFileSync(zip);
  const url = `https://github.com/${repo}/releases/download/${tag}/${asset}`;

  // 4. Publish: a release for a version that has none. One that has is not touched, and what the index says
  // of it is what is there, since a zip made again would not be the same file.
  if (publish) {
    if (gh('release', 'view', tag).status === 0) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      say(`  ${tag}: already released`);
    } else {
      execFileSync('gh', ['release', 'create', tag, zip, '--title', `${result.name} ${result.version}`, '--notes', `${result.description ?? ''}`, '--latest=false'], { cwd: root, stdio: 'inherit' });
      say(`  ${tag}: released`);
    }
  }

  entries.push({
    id,
    name: result.name,
    description: result.description ?? '',
    version: result.version,
    author: typeof raw.author === 'string' ? raw.author : raw.author?.name ?? null,
    nodePart: result.nodePart,
    permissions: result.permissions,
    requires: result.requires,
    dependencies: result.dependencies,
    url,
    sha256: sha256(bytes),
    size: bytes.length,
  });
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

// --- the index ---------------------------------------------------------------------------------------

const index = path.join(dist, 'index.json');
fs.writeFileSync(index, JSON.stringify({ formatVersion: 1, generatedAt: new Date().toISOString(), mods: entries }, null, 2));
say(`wrote ${index}`);

if (publish) {
  if (gh('release', 'view', 'index').status !== 0) {
    execFileSync('gh', ['release', 'create', 'index', '--title', 'index', '--notes', 'index.json: what the launcher lists. Replaced by the automation on every change; not a release of anything.', '--latest=false'], { cwd: root, stdio: 'inherit' });
  }
  execFileSync('gh', ['release', 'upload', 'index', index, '--clobber'], { cwd: root, stdio: 'inherit' });
  say('index.json published');
}
