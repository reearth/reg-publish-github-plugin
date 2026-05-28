# reg-publish-github-releases-plugin

A [reg-suit](https://github.com/reg-viz/reg-suit) **publisher plugin** that stores visual-regression
snapshots as **GitHub Releases assets** — one `<commitHash>.zip` per snapshot set, on a single fixed
prerelease.

No external cloud account (S3/GCS) and no binaries committed to git history. Just a GitHub token.

## Why

The officially maintained reg-suit publishers (`reg-publish-s3-plugin`, `reg-publish-gcs-plugin`) need a
cloud storage account. The community `reg-publish-github-pages-plugin` stores binaries in git history
(branch/clone bloat) and is unmaintained. This plugin fills the gap: a maintained, GitHub-native
publisher that avoids both external cloud accounts **and** git binary bloat.

## How it works

reg-suit addresses snapshots by **commit hash**. This plugin keeps every snapshot set as one zip asset
on a single, never-moving GitHub **prerelease**:

- `publish(actualKey)` → zips the current snapshot directory and uploads it as `<actualKey>.zip`.
- `fetch(expectedKey)` → downloads `<expectedKey>.zip` and unzips it into the *expected* directory, so
  the **actual** snapshots of the base commit become the **expected** snapshots of the current one.

A prerelease (not a draft) is used because draft asset URLs require auth, which would break public
`fetch`; the prerelease keeps assets downloadable while staying out of the "Latest release" badge.

## Install

```bash
npm install --save-dev reg-publish-github-releases-plugin
```

## Configure

Run the interactive setup:

```bash
npx reg-suit prepare -p github-releases
```

…or add the block to `regconfig.json` manually:

```jsonc
{
  "core": {
    "workingDir": ".reg",
    "actualDir": "__screenshots__"
  },
  "plugins": {
    "reg-publish-github-releases-plugin": {
      "repository": "owner/repo",   // optional; inferred from the git `origin` remote
      "tagName": "reg-snapshots",   // fixed release tag (default)
      "pathPrefix": "",             // optional namespace prepended to asset names
      "retentionDays": 30,          // delete snapshots older than this (default)
      "retentionCount": 200         // optional cap on the number of snapshots kept
    }
  }
}
```

### Options

| Option           | Default                  | Description                                                              |
| ---------------- | ------------------------ | ------------------------------------------------------------------------ |
| `repository`     | inferred from git remote | `owner/repo` of the storage repo.                                        |
| `tagName`        | `reg-snapshots`          | Tag of the fixed prerelease holding the assets.                          |
| `token`          | `$GITHUB_TOKEN`          | Token with `contents: write` on the storage repo.                        |
| `pathPrefix`     | `""`                     | Namespace prepended to each asset name (e.g. `ios-`).                    |
| `retentionDays`  | `30`                     | Snapshots older than this are garbage-collected after each publish.      |
| `retentionCount` | _none_                   | Optional secondary cap: keep at most N most-recent snapshots.            |

The token is read from `regconfig.json` (`token`), else `$GITHUB_TOKEN`, else `$GH_TOKEN`.

## Authentication

You need a token with `contents: write` on the storage repo.

- **Same repo** (snapshots stored in the repo under test) — GitHub Actions' built-in token works:

  ```yaml
  permissions:
    contents: write
  steps:
    - run: npx reg-suit run
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  ```

- **Separate storage repo** — use a PAT / fine-grained token scoped to that repo.

## Retention

reg-suit compares against the **base commit** (for a PR, the merge-base — often an older `main` commit),
so a "keep only the latest" policy would break PR comparisons. Instead this plugin uses an **age-based
window**: after each publish it deletes snapshot assets older than `retentionDays` (default 30). The
just-published set is never collected (GC runs after upload). Set `retentionDays` comfortably longer than
your expected PR lifetime — a long-lived PR whose base falls outside the window degrades to "all new".

## Reports

GitHub Releases stores files but cannot serve a browsable HTML report, so this plugin (v1) stores
**snapshots only** and returns no `reportUrl`. Pair it with
[`reg-notify-github-plugin`](https://github.com/reg-viz/reg-suit) to post a PR comment.

## Development

```bash
npm install
npm run build      # compile to dist/
npm test           # unit tests (vitest)
npm run e2e        # round-trip test against a real repo (see e2e/script.ts for required env)
```

## License

MIT
