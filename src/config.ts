import { execSync } from "child_process";

import type { PluginLogger } from "reg-suit-interface";

/**
 * User-facing plugin configuration, as written into `regconfig.json` under
 * `plugins["reg-publish-github-plugin"]`.
 */
/** Storage backend for snapshots. */
export type Backend = "releases" | "ghcr";

export interface PluginConfig {
  /**
   * Storage backend. Default: "releases".
   *   - "releases": one `<hash>.zip` asset on a fixed GitHub prerelease (needs `contents: write`).
   *   - "ghcr": one OCI artifact tagged `<hash>` in GHCR, with layer-level dedup (needs `packages: write`).
   */
  backend?: Backend;
  /** "owner/repo" of the storage repo. Default: inferred from the `origin` git remote. */
  repository?: string;
  /**
   * Releases backend: tag of the fixed prerelease holding the assets.
   * GHCR backend: the image name appended to the repo path (`<registry>/<owner>/<repo>/<tagName>`).
   * Default: "reg-snapshots".
   */
  tagName?: string;
  /** Token with the required scope on the storage repo. Default: `process.env.GITHUB_TOKEN`. */
  token?: string;
  /** Optional namespace prepended to each asset name (Releases backend only, e.g. "ios-"). */
  pathPrefix?: string;
  /** Delete snapshots older than this many days. Default: 30. */
  retentionDays?: number;
  /** Optional secondary cap: keep at most this many most-recent snapshots. */
  retentionCount?: number;
  /**
   * Releases backend: mark the snapshot published in this run as *protected*, so
   * the `retentionCount` cap never evicts it. Use it to pin default-branch
   * baselines while ephemeral PR snapshots churn within the cap. The age cap
   * (`retentionDays`) still applies. Overridden by the `REG_PUBLISH_PROTECTED`
   * env var when set (truthy: `1`/`true`/`yes`), which is the practical way to
   * protect only default-branch runs from a single static config. Default: false.
   */
  protected?: boolean;
  /** GHCR backend: container registry host. Default: "ghcr.io". */
  registry?: string;
  /** GHCR backend: username for registry auth. Default: `$GITHUB_ACTOR`, else the repo owner. */
  username?: string;
}

/** Fully resolved config, with every value concrete and validated. */
export interface ResolvedConfig {
  backend: Backend;
  owner: string;
  repo: string;
  tagName: string;
  token: string;
  pathPrefix: string;
  retentionDays: number;
  retentionCount?: number;
  protected: boolean;
  registry: string;
  username: string;
}

export const DEFAULT_TAG_NAME = "reg-snapshots";
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_BACKEND: Backend = "releases";
export const DEFAULT_REGISTRY = "ghcr.io";

/** Asset label marking a snapshot as protected (exempt from the count cap). */
export const PROTECTED_LABEL = "protected";

/**
 * Parse a boolean-ish env var. Returns `undefined` when unset/empty so callers
 * can fall back to config; `true` for `1`/`true`/`yes` (case-insensitive).
 */
export function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return /^(1|true|yes)$/i.test(value.trim());
}

/**
 * Parse an "owner/repo" string or a git remote URL into its parts.
 * Supports the common forms:
 *   - owner/repo
 *   - git@github.com:owner/repo.git
 *   - https://github.com/owner/repo(.git)
 *   - ssh://git@github.com/owner/repo.git
 */
export function parseRepository(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\.git$/, "");
  // Bare "owner/repo".
  const bare = /^([^/\s:]+)\/([^/\s:]+)$/.exec(trimmed);
  if (bare) {
    return { owner: bare[1], repo: bare[2] };
  }
  // scp-like or URL form: capture the last two path-ish segments.
  const m = /[/:]([^/\s:]+)\/([^/\s:]+)$/.exec(trimmed);
  if (m) {
    return { owner: m[1], repo: m[2] };
  }
  return null;
}

function inferRepositoryFromGit(logger?: PluginLogger): string | undefined {
  try {
    return execSync("git remote get-url origin", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    logger?.warn("Could not infer repository from `git remote get-url origin`.");
    return undefined;
  }
}

/**
 * Resolve a partial {@link PluginConfig} into a concrete {@link ResolvedConfig},
 * filling in defaults and validating that the required values are present.
 * Throws with an actionable message when something essential is missing.
 */
export function resolveConfig(config: PluginConfig, logger?: PluginLogger): ResolvedConfig {
  const backend = config.backend ?? DEFAULT_BACKEND;
  if (backend !== "releases" && backend !== "ghcr") {
    throw new Error(`reg-publish-github-plugin: backend must be "releases" or "ghcr", got "${backend}".`);
  }

  const repository = config.repository ?? inferRepositoryFromGit(logger);
  if (!repository) {
    throw new Error(
      "reg-publish-github-plugin: `repository` is not set and could not be inferred from the git remote. " +
        'Set `repository: "owner/repo"` in regconfig.json.',
    );
  }

  const parsed = parseRepository(repository);
  if (!parsed) {
    throw new Error(`reg-publish-github-plugin: could not parse repository "${repository}". Expected "owner/repo".`);
  }

  const token = config.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      "reg-publish-github-plugin: no token available. Set `token` in regconfig.json or the " +
        "GITHUB_TOKEN environment variable (needs `contents: write` on the storage repo).",
    );
  }

  const retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (!(retentionDays > 0)) {
    throw new Error(`reg-publish-github-plugin: retentionDays must be a positive number, got ${config.retentionDays}.`);
  }

  if (config.retentionCount !== undefined && !(config.retentionCount > 0)) {
    throw new Error(
      `reg-publish-github-plugin: retentionCount must be a positive number, got ${config.retentionCount}.`,
    );
  }

  const protectedSnapshot = parseBoolEnv(process.env.REG_PUBLISH_PROTECTED) ?? config.protected ?? false;

  return {
    backend,
    owner: parsed.owner,
    repo: parsed.repo,
    tagName: config.tagName ?? DEFAULT_TAG_NAME,
    token,
    pathPrefix: config.pathPrefix ?? "",
    retentionDays,
    retentionCount: config.retentionCount,
    protected: protectedSnapshot,
    registry: config.registry ?? DEFAULT_REGISTRY,
    username: config.username ?? process.env.GITHUB_ACTOR ?? parsed.owner,
  };
}

/** Build the asset name for a snapshot key: `${pathPrefix}${key}.zip`. */
export function assetNameForKey(key: string, pathPrefix = ""): string {
  return `${pathPrefix}${key}.zip`;
}

/**
 * Reverse of {@link assetNameForKey}: extract the snapshot key from an asset
 * name, or `null` if the name is not one of our snapshot assets.
 */
export function keyFromAssetName(name: string, pathPrefix = ""): string | null {
  if (!name.endsWith(".zip")) return null;
  if (pathPrefix && !name.startsWith(pathPrefix)) return null;
  return name.slice(pathPrefix.length, name.length - ".zip".length);
}
