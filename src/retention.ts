import { keyFromAssetName, PROTECTED_LABEL } from "./config";
import type { ReleaseAsset } from "./octokit-client";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  /** Snapshots older than this many days are collected (applies to every snapshot). */
  retentionDays: number;
  /** Optional cap on the ephemeral (non-protected) pool's size. */
  retentionCount?: number;
  /** Optional cap on the protected pool's size. */
  protectedRetentionCount?: number;
  /** Namespace prepended to asset names; used to tell snapshots from other assets. */
  pathPrefix: string;
}

/**
 * Decide which snapshot assets to garbage-collect after a publish.
 *
 *   - **Age cap** (`retentionDays`) applies to every snapshot, protected or not.
 *   - **Count cap** (`retentionCount`) applies only to the *ephemeral* pool —
 *     snapshots without the {@link PROTECTED_LABEL} label — so pinned baselines
 *     are never evicted by a churn of PR snapshots.
 *   - **Protected count cap** (`protectedRetentionCount`) bounds the protected
 *     pool independently, keeping only its most-recent N so a busy default
 *     branch does not pile baselines up to the age limit.
 *   - `protectName` (the asset just uploaded this run) is always kept, regardless
 *     of either cap or clock skew between the upload and this listing.
 *
 * Non-snapshot assets (anything not matching `pathPrefix…​.zip`) are ignored.
 */
export function selectAssetsToDelete(
  assets: ReleaseAsset[],
  policy: RetentionPolicy,
  protectName: string,
  now: number,
): ReleaseAsset[] {
  const snapshots = assets
    .filter(a => keyFromAssetName(a.name, policy.pathPrefix) !== null)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)); // newest first

  const cutoff = now - policy.retentionDays * MS_PER_DAY;
  const toDelete = new Map<number, ReleaseAsset>();

  // Age cap: every snapshot past the window, protected or not.
  for (const asset of snapshots) {
    if (Date.parse(asset.created_at) < cutoff) toDelete.set(asset.id, asset);
  }

  // Count cap: only the ephemeral (non-protected) pool, so pinned baselines
  // survive a flood of PR snapshots.
  if (policy.retentionCount !== undefined) {
    const ephemeral = snapshots.filter(a => a.label !== PROTECTED_LABEL);
    for (const asset of ephemeral.slice(policy.retentionCount)) toDelete.set(asset.id, asset);
  }

  // Protected count cap: bound the protected pool to its most-recent N.
  if (policy.protectedRetentionCount !== undefined) {
    const protectedSnaps = snapshots.filter(a => a.label === PROTECTED_LABEL);
    for (const asset of protectedSnaps.slice(policy.protectedRetentionCount)) toDelete.set(asset.id, asset);
  }

  // Never collect the set we just uploaded.
  const protectedAsset = snapshots.find(a => a.name === protectName);
  if (protectedAsset) toDelete.delete(protectedAsset.id);

  return [...toDelete.values()];
}
