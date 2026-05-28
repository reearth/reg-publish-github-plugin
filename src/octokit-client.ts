// `@octokit/rest` is ESM-only, but reg-suit loads plugins via CommonJS `require`.
// We therefore import it lazily with a dynamic `import()` (preserved verbatim by
// the `node16` module target) so the package works in both module systems.
type Octokit = import("@octokit/rest", { with: { "resolution-mode": "import" } }).Octokit;

export interface ReleaseAsset {
  id: number;
  name: string;
  /** ISO 8601 timestamp. */
  created_at: string;
  browser_download_url: string;
  size: number;
}

export interface Release {
  id: number;
  tag_name: string;
  html_url: string;
}

/** Thin wrapper around `@octokit/rest` for the release/asset operations we need. */
export class OctokitClient {
  private octokitPromise?: Promise<Octokit>;

  constructor(
    private readonly token: string,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  private getOctokit(): Promise<Octokit> {
    if (!this.octokitPromise) {
      this.octokitPromise = import("@octokit/rest").then(({ Octokit }) => new Octokit({ auth: this.token }));
    }
    return this.octokitPromise;
  }

  /** Get the release for `tag`, or `null` if it does not exist. */
  async getReleaseByTag(tag: string): Promise<Release | null> {
    const octokit = await this.getOctokit();
    try {
      const { data } = await octokit.repos.getReleaseByTag({ owner: this.owner, repo: this.repo, tag });
      return data;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Get the fixed snapshot release, creating it as a prerelease pinned to the
   * default branch tip when missing. Idempotent under concurrent callers: if a
   * creation races and loses, we re-fetch the now-existing release.
   */
  async ensureRelease(tag: string): Promise<Release> {
    const existing = await this.getReleaseByTag(tag);
    if (existing) return existing;

    const octokit = await this.getOctokit();
    try {
      const { data } = await octokit.repos.createRelease({
        owner: this.owner,
        repo: this.repo,
        tag_name: tag,
        name: tag,
        prerelease: true,
        body:
          "Storage for reg-suit visual-regression snapshots. " +
          "Managed by reg-publish-github-plugin — do not edit or delete.",
      });
      return data;
    } catch (err) {
      // Another process may have created it between our check and create.
      const raced = await this.getReleaseByTag(tag);
      if (raced) return raced;
      throw err;
    }
  }

  /** List every asset on a release, following pagination. */
  async listAssets(releaseId: number): Promise<ReleaseAsset[]> {
    const octokit = await this.getOctokit();
    return octokit.paginate(octokit.repos.listReleaseAssets, {
      owner: this.owner,
      repo: this.repo,
      release_id: releaseId,
      per_page: 100,
    });
  }

  async deleteAsset(assetId: number): Promise<void> {
    const octokit = await this.getOctokit();
    await octokit.repos.deleteReleaseAsset({ owner: this.owner, repo: this.repo, asset_id: assetId });
  }

  async uploadAsset(releaseId: number, name: string, data: Buffer): Promise<ReleaseAsset> {
    const octokit = await this.getOctokit();
    const res = await octokit.repos.uploadReleaseAsset({
      owner: this.owner,
      repo: this.repo,
      release_id: releaseId,
      name,
      // octokit's types want a string, but a Buffer is accepted at runtime.
      data: data as unknown as string,
      headers: {
        "content-type": "application/zip",
        "content-length": data.length,
      },
    });
    return res.data;
  }

  /**
   * Download an asset's bytes. Uses the asset API with an octet-stream Accept
   * header so it works for both public and private repos (octokit follows the
   * redirect to the CDN and returns the raw bytes).
   */
  async downloadAsset(assetId: number): Promise<Buffer> {
    const octokit = await this.getOctokit();
    const res = await octokit.repos.getReleaseAsset({
      owner: this.owner,
      repo: this.repo,
      asset_id: assetId,
      headers: { accept: "application/octet-stream" },
    });
    return Buffer.from(res.data as unknown as ArrayBuffer);
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 404;
}
