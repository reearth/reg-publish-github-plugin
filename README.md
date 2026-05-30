# reg-publish-github-plugin

A [reg-suit](https://github.com/reg-viz/reg-suit) **publisher plugin** that stores visual-regression
snapshots on GitHub itself — no external cloud account (S3/GCS) and no binaries committed to git history.
Just a GitHub token. Pick one of two backends with a single config option:

- **`releases`** (default) — one `<commitHash>.zip` per snapshot set, as assets on a fixed prerelease.
  Simple; needs `contents: write`.
- **`ghcr`** — one OCI artifact tagged `<commitHash>` in the GitHub Container Registry, with each file
  stored as its own blob so **unchanged images dedup across commits**. Most storage-efficient; needs
  `packages: write`.

## Why

The officially maintained reg-suit publishers (`reg-publish-s3-plugin`, `reg-publish-gcs-plugin`) need a
cloud storage account. The community `reg-publish-github-pages-plugin` stores binaries in git history
(branch/clone bloat) and is unmaintained. This plugin fills the gap: a maintained, GitHub-native
publisher that avoids both external cloud accounts **and** git binary bloat.

## How it works

reg-suit addresses snapshots by **commit hash**, and both backends preserve the same idea: the **actual**
snapshots of the base commit become the **expected** snapshots of the current one.

**Releases backend** keeps every snapshot set as one zip asset on a single, never-moving **prerelease**:

- `publish(actualKey)` → zips the current snapshot directory and uploads it as `<actualKey>.zip`.
- `fetch(expectedKey)` → downloads `<expectedKey>.zip` and unzips it into the *expected* directory.

A prerelease (not a draft) is used because draft asset URLs require auth, which would break public
`fetch`; the prerelease keeps assets downloadable while staying out of the "Latest release" badge.

**GHCR backend** pushes each snapshot set as an OCI artifact to
`ghcr.io/<owner>/<repo>/<tagName>:<commitHash>`. Each file becomes its own content-addressable blob, so
files unchanged between commits are stored once and shared — storage grows with *changes*, not with
*commits × images*.

- `publish(actualKey)` → uploads each file's blob (skipping any the registry already has) and pushes a
  manifest tagged `actualKey`.
- `fetch(expectedKey)` → pulls the manifest tagged `expectedKey` and writes each blob into the *expected*
  directory using its path annotation. A missing tag resolves to "all new" (never throws).

## Install

```bash
npm install --save-dev reg-publish-github-plugin
```

## Configure

Run the interactive setup:

```bash
npx reg-suit prepare -p github
```

…or add the block to `regconfig.json` manually.

Releases backend (default):

```jsonc
{
  "core": {
    "workingDir": ".reg",
    "actualDir": "__screenshots__"
  },
  "plugins": {
    "reg-publish-github-plugin": {
      "backend": "releases",        // default; can be omitted
      "repository": "owner/repo",   // optional; inferred from the git `origin` remote
      "tagName": "reg-snapshots",   // fixed release tag (default)
      "pathPrefix": "",             // optional namespace prepended to asset names
      "retentionDays": 30,          // delete snapshots older than this (default)
      "retentionCount": 30,         // optional cap on non-protected snapshots (full zip each — keep modest)
      "protectedRetentionCount": 20,// optional cap on the protected (pinned) pool
      "protected": false            // pin this run's snapshot (exempt from the count cap)
    }
  }
}
```

GHCR backend (switch with `"backend": "ghcr"`):

```jsonc
{
  "plugins": {
    "reg-publish-github-plugin": {
      "backend": "ghcr",
      "repository": "owner/repo",   // optional; inferred from the git `origin` remote
      "tagName": "reg-snapshots",   // image name → ghcr.io/owner/repo/reg-snapshots
      "registry": "ghcr.io",        // default
      "retentionDays": 30
    }
  }
}
```

### Options

| Option           | Default                  | Description                                                                       |
| ---------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `backend`        | `releases`               | `releases` (zip assets) or `ghcr` (OCI artifacts with layer dedup).              |
| `repository`     | inferred from git remote | `owner/repo` of the storage repo.                                                |
| `tagName`        | `reg-snapshots`          | Releases: the fixed prerelease tag. GHCR: the image name in the repo path.        |
| `token`          | `$GITHUB_TOKEN`          | Token with the required scope (see below).                                        |
| `pathPrefix`     | `""`                     | Releases only: namespace prepended to each asset name (e.g. `ios-`).             |
| `retentionDays`  | `30`                     | Snapshots older than this are garbage-collected after each publish.               |
| `retentionCount` | _none_                   | Optional secondary cap: keep at most N most-recent **non-protected** snapshots.    |
| `protectedRetentionCount` | _none_          | Optional cap on the **protected** pool: keep at most N most-recent pinned snapshots (else bounded only by `retentionDays`). |
| `protected`      | `false`                  | Releases only: pin this run's snapshot so `retentionCount` never evicts it. Override per-run with the `REG_PUBLISH_PROTECTED` env var (`1`/`true`/`yes`). |
| `registry`       | `ghcr.io`                | GHCR only: container registry host.                                              |
| `username`       | `$GITHUB_ACTOR` / owner  | GHCR only: username for registry auth.                                            |

The token is read from `regconfig.json` (`token`), else `$GITHUB_TOKEN`, else `$GH_TOKEN`.

## Authentication

The required scope depends on the backend.

- **Releases** → `contents: write` on the storage repo.
- **GHCR** → `packages: write` (and `packages: delete`, i.e. a PAT with `delete:packages`, for retention).

In GitHub Actions, the built-in token works when the storage repo/package belongs to the same repo:

```yaml
permissions:
  contents: write   # releases backend
  packages: write   # ghcr backend
steps:
  - run: npx reg-suit run
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

For a **separate** storage repo, use a PAT / fine-grained token scoped to that repo (or package).

## Retention

reg-suit compares against the **base commit** (for a PR, the merge-base — often an older `main` commit),
so a naive "keep only the latest N" policy would break PR comparisons by evicting the very baseline a PR
needs. The plugin therefore uses two caps:

- **Age window** (`retentionDays`, default 30): after each publish it deletes snapshots older than the
  window. Set this comfortably longer than your expected PR lifetime — a long-lived PR whose base falls
  outside the window degrades to "all new".
- **Count cap** (`retentionCount`, optional): keeps at most N most-recent snapshots — but only counts
  **non-protected** ones, so a flood of PR snapshots can never push a baseline out of the window. The
  releases backend stores a full zip per snapshot (no cross-snapshot dedup), so keep N modest (tens, not
  hundreds); GHCR dedups shared layers and can afford a larger cap.

The just-published set is never collected (GC runs after upload).

### Pinning baselines (`protected`)

reg-suit only ever notifies (PR comment / commit status) as part of a **publish**, so to keep that
feedback you typically publish on every PR — but you don't want those ephemeral PR snapshots to either
pile up or evict your `main` baselines under `retentionCount`. Mark default-branch publishes as
**protected** and they're exempt from the count cap (the age window still applies). Drive it per-event
with the `REG_PUBLISH_PROTECTED` env var so one static `regconfig.json` covers both.

Protected snapshots are otherwise bounded only by `retentionDays`, so a busy default branch can pile them
up within the window. Set `protectedRetentionCount` to also cap the protected pool to its most-recent N —
enough to cover the baselines your open PRs are likely to branch from. Either way, the snapshot just
published always survives.

```yaml
permissions:
  contents: write
steps:
  - run: npx reg-suit run
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      # Pin snapshots published from the default branch; PR snapshots stay ephemeral.
      REG_PUBLISH_PROTECTED: ${{ github.ref == 'refs/heads/main' }}
```

```jsonc
// regconfig.json — cap ephemeral PR snapshots at 10; protected main baselines are never counted.
"reg-publish-github-plugin": { "backend": "releases", "retentionCount": 10 }
```

For the GHCR backend, retention deletes old **package versions**; GHCR then garbage-collects any blobs no
longer referenced by a surviving version — so shared (unchanged) images stay as long as some kept version
needs them. This step needs `delete:packages` and is best-effort (a missing scope only logs a warning).

## Reports

Neither backend can serve a browsable HTML report, so this plugin stores **snapshots only** and returns
no `reportUrl`. Pair it with [`reg-notify-github-plugin`](https://github.com/reg-viz/reg-suit) to post a
PR comment.

## Development

```bash
npm install
npm run build      # compile to dist/
npm test           # unit tests (vitest)
npm run e2e        # releases round-trip test against a real repo (see e2e/script.ts for required env)
npm run e2e:ghcr   # ghcr round-trip test; needs a token with packages:write (see e2e/ghcr.ts)
```

## License

MIT
