// Copies the case files and the policy config into ui/data/ so the deployed app
// carries them.
//
// Locally the UI can read ../cases and ../config directly. A host that deploys
// only the ui/ directory cannot, so the data is vendored in at build time. Runs
// from predev and prebuild.
//
// LIVE-* cases are ad-hoc investigations from the UI, not submissions, so they
// are not vendored.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(UI_ROOT, '..');
const OUT = path.join(UI_ROOT, 'data');

const srcCases = path.join(REPO_ROOT, 'cases');
const srcConfig = path.join(REPO_ROOT, 'config');

if (!existsSync(srcCases)) {
  console.log('sync-data: no ../cases directory, leaving ui/data as it is');
  process.exit(0);
}

rmSync(path.join(OUT, 'cases'), { recursive: true, force: true });
mkdirSync(path.join(OUT, 'cases'), { recursive: true });

let copied = 0;
for (const file of readdirSync(srcCases)) {
  if (!file.endsWith('.json') || file.startsWith('LIVE-')) continue;
  cpSync(path.join(srcCases, file), path.join(OUT, 'cases', file));
  copied += 1;
}

mkdirSync(path.join(OUT, 'config'), { recursive: true });
for (const file of ['permissions.json', 'policy_rules.json']) {
  const from = path.join(srcConfig, file);
  if (existsSync(from)) cpSync(from, path.join(OUT, 'config', file));
}

writeFileSync(
  path.join(OUT, 'manifest.json'),
  JSON.stringify({ cases: copied, syncedAt: new Date().toISOString() }, null, 2) + '\n',
  'utf8',
);
console.log(`sync-data: vendored ${copied} case files and the policy config into ui/data/`);
