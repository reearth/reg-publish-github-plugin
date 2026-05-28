import fs from "fs";
import path from "path";

import type {
  PluginCreateOptions,
  PublisherPlugin,
  PublishResult,
  WorkingDirectoryInfo,
  PluginLogger,
} from "reg-suit-interface";

import { resolveConfig, type PluginConfig, type ResolvedConfig } from "./config";
import { walkFiles } from "./file-walk";
import { GhcrPackages } from "./ghcr-packages";
import { MEDIA_LAYER, OciClient, TITLE_ANNOTATION, sha256, type OciLayer } from "./oci-client";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Stores each snapshot set as an OCI artifact in GHCR, tagged with the commit
 * hash. Each snapshot file becomes its own blob (annotated with its relative
 * path), so unchanged files across commits share a single blob — storage grows
 * with *changes*, not with *commits × images*.
 *
 *   - `publish(actualKey)`: upload each file's blob (skipping ones the registry
 *     already has) and push a manifest tagged `actualKey`.
 *   - `fetch(expectedKey)`: pull the manifest tagged `expectedKey` and write each
 *     referenced blob into `workingDirs.expectedDir` using its path annotation.
 */
export class GhcrPublisherPlugin implements PublisherPlugin<PluginConfig> {
  name = "reg-publish-github-plugin";

  private noEmit = false;
  private logger!: PluginLogger;
  private workingDirs!: WorkingDirectoryInfo;
  private config!: ResolvedConfig;
  private client!: OciClient;

  init(config: PluginCreateOptions<PluginConfig>): void {
    this.noEmit = config.noEmit;
    this.logger = config.logger;
    this.workingDirs = config.workingDirs;
    this.config = resolveConfig(config.options ?? {}, config.logger);
    this.client = new OciClient({
      registry: this.config.registry,
      imagePath: this.imagePath(),
      username: this.config.username,
      token: this.config.token,
    });
  }

  private imagePath(): string {
    return `${this.config.owner}/${this.config.repo}/${this.config.tagName}`;
  }

  async publish(key: string): Promise<PublishResult> {
    const files = walkFiles(this.workingDirs.actualDir);

    if (this.noEmit) {
      this.logger.info(`(dry-run) Would push ${files.length} blob(s) tagged ${this.logger.colors.magenta(key)}.`);
      return { reportUrl: undefined };
    }

    const ref = `${this.config.registry}/${this.imagePath()}:${key}`;
    this.logger.info(`Pushing snapshot ${this.logger.colors.magenta(ref)} (${files.length} file(s)).`);

    const layers: OciLayer[] = [];
    for (const file of files) {
      const data = fs.readFileSync(file.absPath);
      const digest = sha256(data);
      await this.client.ensureBlob(digest, data);
      layers.push({
        mediaType: MEDIA_LAYER,
        digest,
        size: data.length,
        annotations: { [TITLE_ANNOTATION]: file.relPath },
      });
    }

    await this.client.pushManifest(key, layers);
    await this.runGc(key);

    return { reportUrl: undefined };
  }

  async fetch(key: string): Promise<unknown> {
    if (this.noEmit) return [];

    const manifest = await this.client.getManifest(key);
    if (!manifest) {
      this.logger.info(`No baseline artifact for ${this.logger.colors.magenta(key)}; treating all images as new.`);
      return [];
    }

    this.logger.info(`Fetching baseline snapshot ${this.logger.colors.magenta(key)} (${manifest.layers.length} file(s)).`);
    const out: { path: string; absPath: string }[] = [];
    for (const layer of manifest.layers) {
      const relPath = layer.annotations?.[TITLE_ANNOTATION];
      if (!relPath) continue; // not a snapshot file (e.g. a config layer)
      const data = await this.client.getBlob(layer.digest);
      const absPath = path.join(this.workingDirs.expectedDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, data);
      out.push({ path: relPath, absPath });
    }
    return out;
  }

  /**
   * Delete package versions older than the retention window (plus any beyond the
   * optional count cap), never collecting the version we just pushed. Best-effort:
   * a missing `delete:packages` scope only logs a warning. Unreferenced blobs are
   * garbage-collected by GHCR — that is the dedup payoff.
   */
  private async runGc(protectKey: string): Promise<void> {
    const packages = new GhcrPackages(this.config.token, this.config.owner, `${this.config.repo}/${this.config.tagName}`);

    let versions;
    try {
      versions = await packages.listVersions();
    } catch (err) {
      this.logger.warn(`Skipping GHCR retention (could not list package versions: ${(err as Error).message}).`);
      return;
    }

    versions.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)); // newest first

    const cutoff = Date.now() - this.config.retentionDays * MS_PER_DAY;
    const toDelete = new Map<number, (typeof versions)[number]>();
    for (const v of versions) {
      if (Date.parse(v.created_at) < cutoff) toDelete.set(v.id, v);
    }
    if (this.config.retentionCount !== undefined) {
      for (const v of versions.slice(this.config.retentionCount)) toDelete.set(v.id, v);
    }

    // Never collect the version we just pushed (tagged with protectKey).
    for (const v of versions) {
      if (v.tags.includes(protectKey)) toDelete.delete(v.id);
    }

    if (toDelete.size === 0) return;

    this.logger.info(`Garbage-collecting ${toDelete.size} old GHCR version(s).`);
    for (const v of toDelete.values()) {
      try {
        await packages.deleteVersion(v.id);
        this.logger.verbose(`Deleted version ${v.id} (created ${v.created_at}).`);
      } catch (err) {
        this.logger.warn(`Could not delete GHCR version ${v.id}: ${(err as Error).message}.`);
      }
    }
  }
}
