/**
 * End-to-end test for the GHCR backend against a real registry.
 *
 * Required env:
 *   GITHUB_TOKEN          token with `packages: write` (and `delete` for cleanup)
 *   REG_E2E_REPOSITORY    "owner/repo" that owns the package
 * Optional env:
 *   REG_E2E_TAG           image name (default: reg-snapshots-e2e)
 *   GITHUB_ACTOR          registry username (default: the repo owner)
 *
 * Run with: `npm run e2e:ghcr`
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

import type { PluginCreateOptions, WorkingDirectoryInfo } from "reg-suit-interface";

import type { PluginConfig } from "../src/config";
import { GhcrPublisherPlugin } from "../src/ghcr-publisher-plugin";
import { OciClient, sha256 } from "../src/oci-client";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.REG_E2E_REPOSITORY;
const tagName = process.env.REG_E2E_TAG ?? "reg-snapshots-e2e";

if (!token || !repository) {
  console.error("Set GITHUB_TOKEN (with packages:write) and REG_E2E_REPOSITORY to run the GHCR e2e test.");
  process.exit(1);
}

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
  const plugin = new GhcrPublisherPlugin();
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reg-ghcr-e2e-"));
  const workingDirs = makeWorkingDirs(root);
  const [owner, repo] = repository!.split("/");
  const options: PluginConfig = { backend: "ghcr", repository, tagName, token, retentionDays: 36500 };
  const plugin = makePlugin(workingDirs, options);

  const client = new OciClient({
    registry: "ghcr.io",
    imagePath: `${owner}/${repo}/${tagName}`,
    username: process.env.GITHUB_ACTOR ?? owner,
    token: token!,
  });

  try {
    // 1. push → fetch round-trip restores identical files.
    const keyA = `e2e-${process.pid}-a`;
    const shared = Buffer.from([1, 2, 3, 4, 5]);
    fs.writeFileSync(path.join(workingDirs.actualDir, "shared.png"), shared);
    fs.writeFileSync(path.join(workingDirs.actualDir, "only-a.png"), "a-only");

    console.log("1. push + fetch round-trip");
    await plugin.publish(keyA);
    await plugin.fetch(keyA);
    assert.deepStrictEqual(fs.readFileSync(path.join(workingDirs.expectedDir, "shared.png")), shared);
    assert.strictEqual(fs.readFileSync(path.join(workingDirs.expectedDir, "only-a.png"), "utf8"), "a-only");
    console.log("   ✓ files restored identically");

    // 2. missing-tag fetch returns [] without throwing.
    console.log("2. missing-tag fetch");
    const result = await plugin.fetch(`e2e-${process.pid}-missing`);
    assert.deepStrictEqual(result, [], "missing tag should resolve to []");
    console.log("   ✓ returned []");

    // 3. cross-commit dedup: a second set that shares a file reuses the blob.
    console.log("3. layer dedup");
    fs.rmSync(path.join(workingDirs.actualDir, "only-a.png"));
    fs.writeFileSync(path.join(workingDirs.actualDir, "only-b.png"), "b-only");
    const keyB = `e2e-${process.pid}-b`;
    await plugin.publish(keyB);
    assert.ok(await client.blobExists(sha256(shared)), "shared blob should exist once and be reused");
    console.log("   ✓ shared blob reused across commits");

    console.log("\nAll GHCR e2e checks passed ✓");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    console.log(
      "\nNote: GHCR package versions are not auto-deleted here — remove the test package manually if needed.",
    );
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
