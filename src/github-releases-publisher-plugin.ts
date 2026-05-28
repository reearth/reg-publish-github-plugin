import path from "path";

import type {
  PluginCreateOptions,
  PublisherPlugin,
  PublishResult,
  WorkingDirectoryInfo,
  PluginLogger,
} from "reg-suit-interface";

import { assetNameForKey, keyFromAssetName, resolveConfig, type PluginConfig, type ResolvedConfig } from "./config";
import { OctokitClient, type ReleaseAsset } from "./octokit-client";
import { unzipToDir, zipDir } from "./zip";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Stores each snapshot set as a single `<commitHash>.zip` asset on a fixed
 * GitHub prerelease. Implements {@link PublisherPlugin} directly (rather than
 * extending `AbstractPublisher`) so the zip-per-key model stays clean.
 *
 *   - `publish(actualKey)`: zip `workingDirs.actualDir` and upload it.
 *   - `fetch(expectedKey)`: download `<expectedKey>.zip` and unzip into
 *     `workingDirs.expectedDir` — the *actual* snapshots of the base commit
 *     become the *expected* snapshots of the current one.
 */
export class GitHubReleasesPublisherPlugin implements PublisherPlugin<PluginConfig> {
  name = "reg-publish-github-releases-plugin";

  private noEmit = false;
  private logger!: PluginLogger;
  private workingDirs!: WorkingDirectoryInfo;
  private config!: ResolvedConfig;
  private client!: OctokitClient;

  init(config: PluginCreateOptions<PluginConfig>): void {
    this.noEmit = config.noEmit;
    this.logger = config.logger;
    this.workingDirs = config.workingDirs;
    this.config = resolveConfig(config.options ?? {}, config.logger);
    this.client = new OctokitClient(this.config.token, this.config.owner, this.config.repo);
  }

  async publish(key: string): Promise<PublishResult> {
    const name = assetNameForKey(key, this.config.pathPrefix);
    const buffer = zipDir(this.workingDirs.actualDir);

    if (this.noEmit) {
      this.logger.info(`(dry-run) Would upload ${this.logger.colors.magenta(name)} (${buffer.length} bytes).`);
      return { reportUrl: undefined };
    }

    const release = await this.client.ensureRelease(this.config.tagName);

    // Replace any asset that already exists for this key (re-run on same commit).
    const assets = await this.client.listAssets(release.id);
    const existing = assets.find(a => a.name === name);
    if (existing) {
      this.logger.verbose(`Removing existing asset ${name} before re-upload.`);
      await this.client.deleteAsset(existing.id);
    }

    this.logger.info(`Uploading snapshot ${this.logger.colors.magenta(name)} (${buffer.length} bytes).`);
    await this.client.uploadAsset(release.id, name, buffer);

    await this.runGc(release.id, name);

    return { reportUrl: undefined };
  }

  async fetch(key: string): Promise<unknown> {
    if (this.noEmit) return [];

    const release = await this.client.getReleaseByTag(this.config.tagName);
    if (!release) {
      this.logger.info(`No snapshot release "${this.config.tagName}" yet; treating all images as new.`);
      return [];
    }

    const name = assetNameForKey(key, this.config.pathPrefix);
    const assets = await this.client.listAssets(release.id);
    const asset = assets.find(a => a.name === name);
    if (!asset) {
      this.logger.info(`No baseline snapshot for ${this.logger.colors.magenta(key)}; treating all images as new.`);
      return [];
    }

    this.logger.info(`Fetching baseline snapshot ${this.logger.colors.magenta(name)} (${asset.size} bytes).`);
    const buffer = await this.client.downloadAsset(asset.id);
    const files = unzipToDir(buffer, this.workingDirs.expectedDir);

    return files.map(p => ({
      path: p,
      absPath: path.join(this.workingDirs.expectedDir, p),
    }));
  }

  /**
   * Delete snapshot assets older than the retention window, plus any beyond the
   * optional count cap. The asset just uploaded in this run (`protectName`) is
   * always kept, so the freshly published set is never collected — even with a
   * tiny retention window or clock skew between upload and this listing.
   */
  private async runGc(releaseId: number, protectName: string): Promise<void> {
    const assets = await this.client.listAssets(releaseId);
    const snapshots = assets
      .filter(a => keyFromAssetName(a.name, this.config.pathPrefix) !== null)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)); // newest first

    const cutoff = Date.now() - this.config.retentionDays * MS_PER_DAY;
    const toDelete = new Map<number, ReleaseAsset>();

    for (const asset of snapshots) {
      if (Date.parse(asset.created_at) < cutoff) {
        toDelete.set(asset.id, asset);
      }
    }
    if (this.config.retentionCount !== undefined) {
      for (const asset of snapshots.slice(this.config.retentionCount)) {
        toDelete.set(asset.id, asset);
      }
    }

    // Never collect the set we just uploaded, regardless of window or clock skew.
    const protectedAsset = snapshots.find(a => a.name === protectName);
    if (protectedAsset) toDelete.delete(protectedAsset.id);

    if (toDelete.size === 0) return;

    this.logger.info(`Garbage-collecting ${toDelete.size} old snapshot asset(s).`);
    for (const asset of toDelete.values()) {
      this.logger.verbose(`Deleting ${asset.name} (created ${asset.created_at}).`);
      await this.client.deleteAsset(asset.id);
    }
  }
}
