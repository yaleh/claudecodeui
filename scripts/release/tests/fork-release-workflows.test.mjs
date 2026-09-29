#!/usr/bin/env node
/**
 * Static guard for the fork release pipeline (yaleh/claudecodeui).
 *
 * The release path diverges from upstream (siteboon) in exactly three shape decisions, and each
 * one is a decision that silently REVERTS the moment someone re-syncs a workflow from upstream:
 *
 *   1. `.release-it.json` publishes a GitHub Release only — `npm.publish=false`, on `develop`,
 *      pushing to the `yaleh` remote. The `@cloudcli-ai/cloudcli` package scope is not ours, so an
 *      accidental `npm.publish=true` fails the run at the publish step (after the tag is already
 *      made) rather than doing nothing.
 *   2. `release.yml` carries no npm publishing surface: no registry, no OIDC `id-token`, no
 *      trusted-publishing npm upgrade. Those exist upstream only to serve `npm publish`.
 *   3. `desktop-release.yml` builds Windows only. There is no Apple signing certificate, so a
 *      re-added `build-macos` job makes `publish.needs` wait on a job that can never go green, and
 *      a re-added `.dmg` assertion fails the publish step on an asset nobody built.
 *
 * This is a static guard, not an integration test: it reads the three files and asserts the shape.
 * It cannot prove the pipeline runs (that is the task's human-gated AC), only that the three
 * decisions have not silently reverted.
 *
 * WHAT IT PRINTS. The six readings named by the criterion are printed unconditionally, before the
 * assertions, so a red run still shows which reading was wrong:
 *
 *   npm.publish=false  requireBranch=develop  pushRepo=yaleh
 *   macos.jobs=0       dmg.refs=0             npm.steps=0
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// `scripts/release/tests/` -> repo root is three levels up.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Read a repo-relative file as UTF-8.
 * @param {string} rel @returns {string}
 */
function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

const RELEASE_YML = '.github/workflows/release.yml';
const DESKTOP_YML = '.github/workflows/desktop-release.yml';

const releaseItText = read('.release-it.json');
const releaseYml = read(RELEASE_YML);
const desktopYml = read(DESKTOP_YML);

/** @type {Record<string, any>} */
const releaseIt = JSON.parse(releaseItText);
const desktopDoc = parseYaml(desktopYml);

/** @type {Record<string, Record<string, unknown>>} */
const desktopJobs =
  desktopDoc && typeof desktopDoc === 'object' && desktopDoc.jobs ? desktopDoc.jobs : {};

// ── the six readings ────────────────────────────────────────────────────────
const npmPublish = releaseIt?.npm?.publish;
const requireBranch = releaseIt?.git?.requireBranch;
const pushRepo = releaseIt?.git?.pushRepo;

// A job counts as macOS if its runner, its id or its display name says so. Any one of the three
// is enough: a re-added `build-macos` is caught even if the runner line is edited.
const macosJobs = Object.entries(desktopJobs).filter(([id, job]) => {
  const runsOn = String(job['runs-on'] ?? '');
  const name = String(job.name ?? '');
  return /macos/i.test(runsOn) || /macos/i.test(name) || /macos/i.test(id);
}).length;

const dmgRefs = (desktopYml.match(/\.dmg/g) ?? []).length;

// Markers that only exist to serve `npm publish`. Deliberately NOT a bare /npm/: `npm ci` and the
// `--no-npm.publish` argument below are legitimate and must not be counted.
const NPM_SURFACE = /registry\.npmjs\.org|id-token|NPM_CONFIG_LOGS_DIR|trusted publishing|npm install -g npm/gi;
const npmSteps = (releaseYml.match(NPM_SURFACE) ?? []).length;

console.log(`npm.publish=${npmPublish}`);
console.log(`requireBranch=${requireBranch}`);
console.log(`pushRepo=${pushRepo}`);
console.log(`macos.jobs=${macosJobs}`);
console.log(`dmg.refs=${dmgRefs}`);
console.log(`npm.steps=${npmSteps}`);

// ── the assertions ──────────────────────────────────────────────────────────

test('.release-it.json targets the fork release path', () => {
  assert.equal(npmPublish, false, 'npm.publish must be false: the @cloudcli-ai package scope is not ours');
  assert.equal(requireBranch, 'develop', 'release-it must run on develop, the fork release branch');
  assert.equal(pushRepo, 'yaleh', 'release-it must push to the yaleh remote, never origin (upstream)');
  // release-it's own default is requireUpstream:true; `develop` in this fork has no tracking
  // branch, so without this the dry run (and the workflow) abort before doing anything.
  assert.equal(releaseIt?.git?.requireUpstream, false, 'release-it must not require a pre-existing upstream branch');
  assert.equal(releaseIt?.github?.release, true, 'the GitHub Release must stay enabled');
});

test('release.yml drops the npm publishing surface', () => {
  assert.equal(npmSteps, 0, `release.yml still references the npm publishing surface (${npmSteps} marker(s))`);
  assert.doesNotMatch(releaseYml, /registry\.npmjs\.org/, 'release.yml must not configure the npm registry');
  assert.doesNotMatch(releaseYml, /id-token/, 'release.yml must not request the OIDC id-token used by npm trusted publishing');
  assert.doesNotMatch(releaseYml, /npm publish/, 'release.yml must not publish to npm');
  assert.match(releaseYml, /--no-npm\.publish/, 'release.yml must still pass --no-npm.publish to release-it');
});

test('desktop-release.yml drops the macOS build', () => {
  assert.equal(macosJobs, 0, `desktop-release.yml builds a macOS job again (${macosJobs})`);
  assert.equal(dmgRefs, 0, `desktop-release.yml still references a .dmg (${dmgRefs})`);
  assert.doesNotMatch(desktopYml, /macos-latest/, 'desktop-release.yml must not use a macOS runner');
  assert.doesNotMatch(desktopYml, /SHASUMS256-macos\.txt/, 'desktop-release.yml must not stage macOS checksums');
  // `secrets.CSC_LINK` / `secrets.APPLE_*` are the Apple-signing surface. The bare `CSC_LINK` env
  // KEY survives inside the Windows job (electron-builder reads that name for the Windows cert),
  // so the check is anchored to the secret reference, not the string.
  assert.doesNotMatch(desktopYml, /secrets\.CSC_LINK\b/, 'desktop-release.yml must not reference the macOS signing certificate');
  assert.doesNotMatch(desktopYml, /secrets\.CSC_KEY_PASSWORD\b/, 'desktop-release.yml must not reference the macOS certificate password');
  assert.doesNotMatch(desktopYml, /APPLE_/, 'desktop-release.yml must not reference Apple notarization secrets');
});

test('desktop-release.yml publish.needs only names real jobs', () => {
  const publish = desktopJobs.publish;
  assert.ok(publish, 'desktop-release.yml needs a publish job');
  const rawNeeds = publish.needs;
  const needs = Array.isArray(rawNeeds) ? rawNeeds : [rawNeeds];
  assert.ok(!needs.includes('build-macos'), 'publish.needs must not require the removed build-macos job');
  for (const id of needs) {
    assert.ok(desktopJobs[String(id)], `publish.needs references a job that does not exist: ${String(id)}`);
  }
});
