/**
 * End-to-end test against a real (throwaway) GitHub repo.
 *
 * Required env:
 *   GITHUB_TOKEN          token with `contents: write` on the storage repo
 *   REG_E2E_REPOSITORY    "owner/repo" of a disposable repo to write to
 * Optional env:
 *   REG_E2E_TAG           tag for the fixed release (default: reg-snapshots-e2e)
 *
 * Run with: `npm run e2e`
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

import type { PluginCreateOptions, WorkingDirectoryInfo } from "reg-suit-interface";

import { assetNameForKey } from "../src/config";
import { GitHubReleasesPublisherPlugin } from "../src/github-releases-publisher-plugin";
import { OctokitClient } from "../src/octokit-client";
import type { PluginConfig } from "../src/config";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.REG_E2E_REPOSITORY;
const tagName = process.env.REG_E2E_TAG ?? "reg-snapshots-e2e";

if (!token || !repository) {
  console.error("Set GITHUB_TOKEN and REG_E2E_REPOSITORY to run the e2e test.");
  process.exit(1);
}

// Minimal no-op logger satisfying the PluginLogger interface.
const noopColors = new Proxy({}, { get: () => (s: string) => s }) as never;
const logger = {
  colors: noopColors,
  getSpinner: () => ({ start() {}, stop() {} }),
  getProgressBar: () => ({ start() {}, update() {}, increment() {}, stop() {} }),
  info: (m: string) => console.log("  ", m),
  warn: (m: string) => console.warn("  ", m),
  error: (m: string | Error) => console.error("  ", m),
  verbose: () => {},
} as const;

function makeWorkingDirs(root: string): WorkingDirectoryInfo {
  const dirs = {
    base: root,
    actualDir: path.join(root, "actual"),
    expectedDir: path.join(root, "expected"),
    diffDir: path.join(root, "diff"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

function makePlugin(workingDirs: WorkingDirectoryInfo, options: PluginConfig) {
  const plugin = new GitHubReleasesPublisherPlugin();
  plugin.init({
    coreConfig: { actualDir: workingDirs.actualDir, workingDir: workingDirs.base },
    workingDirs,
    logger: logger as never,
    noEmit: false,
    options,
  } as PluginCreateOptions<PluginConfig>);
  return plugin;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reg-e2e-"));
  const workingDirs = makeWorkingDirs(root);
  const options: PluginConfig = { repository, tagName, token, retentionDays: 36500 };
  const plugin = makePlugin(workingDirs, options);

  const [owner, repo] = repository!.split("/");
  const client = new OctokitClient(token!, owner, repo);
  const uploadedKeys: string[] = [];

  try {
    // 1. publish → fetch round-trip restores identical files.
    const key = `e2e-${process.pid}-a`;
    uploadedKeys.push(key);
    fs.writeFileSync(path.join(workingDirs.actualDir, "img.png"), Buffer.from([10, 20, 30, 40]));
    fs.mkdirSync(path.join(workingDirs.actualDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(workingDirs.actualDir, "sub", "img2.png"), "second");

    console.log("1. publish + fetch round-trip");
    await plugin.publish(key);
    await plugin.fetch(key);
    assert.deepStrictEqual(
      fs.readFileSync(path.join(workingDirs.expectedDir, "img.png")),
      Buffer.from([10, 20, 30, 40]),
      "img.png should round-trip identically",
    );
    assert.strictEqual(fs.readFileSync(path.join(workingDirs.expectedDir, "sub", "img2.png"), "utf8"), "second");
    console.log("   ✓ files restored identically");

    // 2. missing-key fetch returns empty (no throw, nothing extracted).
    console.log("2. missing-key fetch");
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reg-e2e-miss-"));
    const missDirs = makeWorkingDirs(emptyRoot);
    const missPlugin = makePlugin(missDirs, options);
    const result = await missPlugin.fetch(`e2e-${process.pid}-does-not-exist`);
    assert.deepStrictEqual(result, [], "missing key should resolve to []");
    assert.deepStrictEqual(fs.readdirSync(missDirs.expectedDir), [], "expected dir should stay empty");
    console.log("   ✓ returned [] and extracted nothing");

    // 3. re-publish same key overwrites.
    console.log("3. re-publish overwrites");
    fs.rmSync(path.join(workingDirs.actualDir, "sub"), { recursive: true, force: true });
    fs.writeFileSync(path.join(workingDirs.actualDir, "img.png"), Buffer.from([99]));
    await plugin.publish(key);
    const release = await client.getReleaseByTag(tagName);
    assert.ok(release, "release should exist");
    const assets = await client.listAssets(release!.id);
    const matching = assets.filter(a => a.name === assetNameForKey(key));
    assert.strictEqual(matching.length, 1, "there should be exactly one asset for the key after re-publish");
    console.log("   ✓ single asset remains after re-publish");

    // 4. retention GC deletes assets older than the window.
    console.log("4. retention GC");
    const gcPlugin = makePlugin(workingDirs, { repository, tagName, token, retentionDays: 0.0000001 });
    const gcKey = `e2e-${process.pid}-gc`;
    uploadedKeys.push(gcKey);
    await gcPlugin.publish(gcKey); // GC runs after upload; old `key` asset is now stale.
    const after = await client.listAssets(release!.id);
    assert.ok(
      !after.some(a => a.name === assetNameForKey(key)),
      "the old asset should have been garbage-collected",
    );
    assert.ok(
      after.some(a => a.name === assetNameForKey(gcKey)),
      "the just-published asset should survive GC",
    );
    console.log("   ✓ old asset collected, fresh asset kept");

    console.log("\nAll e2e checks passed ✓");
  } finally {
    // Clean up: delete every asset we created.
    const release = await client.getReleaseByTag(tagName);
    if (release) {
      const assets = await client.listAssets(release.id);
      for (const a of assets) {
        if (uploadedKeys.some(k => a.name === assetNameForKey(k))) {
          await client.deleteAsset(a.id).catch(() => {});
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
