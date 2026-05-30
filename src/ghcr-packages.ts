// `@octokit/rest` is ESM-only; load it lazily so this works under CommonJS too.
type Octokit = import("@octokit/rest", { with: { "resolution-mode": "import" } }).Octokit;

export interface PackageVersion {
  id: number;
  /** ISO 8601 timestamp. */
  created_at: string;
  /** Container tags pointing at this version (e.g. commit hashes). */
  tags: string[];
}

/**
 * Manages GHCR (container) package versions for retention. The package name is
 * everything after the owner — for `ghcr.io/owner/repo/reg-snapshots` that is
 * `repo/reg-snapshots`. Owners may be orgs or users, so each call tries the org
 * endpoint first and falls back to the user endpoint.
 */
export class GhcrPackages {
  private octokitPromise?: Promise<Octokit>;

  constructor(
    private readonly token: string,
    private readonly owner: string,
    private readonly packageName: string,
  ) {}

  private getOctokit(): Promise<Octokit> {
    if (!this.octokitPromise) {
      this.octokitPromise = import("@octokit/rest").then(({ Octokit }) => new Octokit({ auth: this.token }));
    }
    return this.octokitPromise;
  }

  async listVersions(): Promise<PackageVersion[]> {
    const octokit = await this.getOctokit();
    const common = { package_type: "container", package_name: this.packageName, per_page: 100 } as const;

    const raw = await firstOk(
      () =>
        octokit.paginate("GET /orgs/{org}/packages/{package_type}/{package_name}/versions", {
          ...common,
          org: this.owner,
        }),
      () =>
        octokit.paginate("GET /users/{username}/packages/{package_type}/{package_name}/versions", {
          ...common,
          username: this.owner,
        }),
    );

    return raw.map((v: any) => ({
      id: v.id as number,
      created_at: v.created_at as string,
      tags: (v.metadata?.container?.tags ?? []) as string[],
    }));
  }

  async deleteVersion(versionId: number): Promise<void> {
    const octokit = await this.getOctokit();
    const common = {
      package_type: "container",
      package_name: this.packageName,
      package_version_id: versionId,
    } as const;
    await firstOk(
      () =>
        octokit.request("DELETE /orgs/{org}/packages/{package_type}/{package_name}/versions/{package_version_id}", {
          ...common,
          org: this.owner,
        }),
      () =>
        octokit.request(
          "DELETE /users/{username}/packages/{package_type}/{package_name}/versions/{package_version_id}",
          {
            ...common,
            username: this.owner,
          },
        ),
    );
  }
}

/** Run `primary`; if it 404s (wrong owner kind), fall back to `secondary`. */
async function firstOk<T>(primary: () => Promise<T>, secondary: () => Promise<T>): Promise<T> {
  try {
    return await primary();
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { status?: number }).status === 404) {
      return secondary();
    }
    throw err;
  }
}
