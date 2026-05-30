import { describe, expect, it } from "vitest";

import { PROTECTED_LABEL } from "./config";
import type { ReleaseAsset } from "./octokit-client";
import { selectAssetsToDelete } from "./retention";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed "now" for deterministic age math

/** Build a snapshot asset; `ageDays` is how long ago it was created. */
function snap(id: number, ageDays: number, opts: { protected?: boolean } = {}): ReleaseAsset {
  return {
    id,
    name: `${id}.zip`,
    label: opts.protected ? PROTECTED_LABEL : null,
    created_at: new Date(NOW - ageDays * DAY).toISOString(),
    browser_download_url: `https://example.com/${id}.zip`,
    size: 1,
  };
}

const ids = (assets: ReleaseAsset[]) => assets.map(a => a.id).sort((a, b) => a - b);

describe("selectAssetsToDelete", () => {
  const policy = { retentionDays: 30, pathPrefix: "" };

  it("collects snapshots older than the age window", () => {
    const assets = [snap(1, 10), snap(2, 40), snap(3, 31)];
    const deleted = selectAssetsToDelete(assets, policy, "999.zip", NOW);
    expect(ids(deleted)).toEqual([2, 3]);
  });

  it("never collects the just-uploaded asset, even if it is past the window", () => {
    const assets = [snap(1, 40), snap(2, 40)];
    const deleted = selectAssetsToDelete(assets, policy, "1.zip", NOW);
    expect(ids(deleted)).toEqual([2]);
  });

  it("ignores non-snapshot assets", () => {
    const report = { ...snap(7, 40), name: "report.html" };
    const deleted = selectAssetsToDelete([report, snap(1, 5)], policy, "1.zip", NOW);
    expect(deleted).toEqual([]);
  });

  describe("count cap", () => {
    const capped = { retentionDays: 3650, retentionCount: 2, pathPrefix: "" };

    it("keeps the N most-recent ephemeral snapshots", () => {
      // newest → oldest: 1 (1d), 2 (2d), 3 (3d), 4 (4d)
      const assets = [snap(4, 4), snap(2, 2), snap(1, 1), snap(3, 3)];
      const deleted = selectAssetsToDelete(assets, capped, "1.zip", NOW);
      expect(ids(deleted)).toEqual([3, 4]); // keep newest 2 (1, 2)
    });

    it("exempts protected snapshots from the count cap", () => {
      // Three protected baselines + two ephemeral, cap of 1: the protected pool
      // is untouched, and only the older ephemeral (#5) is collected. Were
      // protected counted, the newest-1 would be a protected baseline and both
      // ephemeral would be dropped.
      const cap1 = { retentionDays: 3650, retentionCount: 1, pathPrefix: "" };
      const assets = [
        snap(1, 10, { protected: true }),
        snap(2, 20, { protected: true }),
        snap(3, 30, { protected: true }),
        snap(4, 1),
        snap(5, 2),
      ];
      const deleted = selectAssetsToDelete(assets, cap1, "4.zip", NOW);
      expect(ids(deleted)).toEqual([5]);
    });

    it("does not let protected snapshots consume ephemeral cap slots", () => {
      // 4 protected (interleaved by age) + 3 ephemeral, cap 2 → keep 2 newest
      // ephemeral regardless of how many protected sort ahead of them.
      const assets = [
        snap(10, 1, { protected: true }),
        snap(11, 3, { protected: true }),
        snap(1, 2),
        snap(2, 4),
        snap(3, 6),
      ];
      const deleted = selectAssetsToDelete(assets, capped, "1.zip", NOW);
      expect(ids(deleted)).toEqual([3]); // ephemeral newest-2 = {1,2}; drop {3}
    });

    it("still applies the age cap to protected snapshots", () => {
      const policyBoth = { retentionDays: 30, retentionCount: 5, pathPrefix: "" };
      const assets = [snap(1, 40, { protected: true }), snap(2, 5, { protected: true })];
      const deleted = selectAssetsToDelete(assets, policyBoth, "2.zip", NOW);
      expect(ids(deleted)).toEqual([1]); // protected but stale → collected by age
    });
  });

  describe("protected count cap", () => {
    const capped = { retentionDays: 3650, protectedRetentionCount: 2, pathPrefix: "" };

    it("keeps the N most-recent protected snapshots", () => {
      const assets = [
        snap(1, 1, { protected: true }),
        snap(2, 2, { protected: true }),
        snap(3, 3, { protected: true }),
        snap(4, 4, { protected: true }),
      ];
      const deleted = selectAssetsToDelete(assets, capped, "1.zip", NOW);
      expect(ids(deleted)).toEqual([3, 4]); // keep newest 2 (1, 2)
    });

    it("does not touch ephemeral snapshots", () => {
      const assets = [
        snap(1, 1, { protected: true }),
        snap(2, 2, { protected: true }),
        snap(3, 3, { protected: true }),
        snap(10, 5),
        snap(11, 6),
      ];
      const deleted = selectAssetsToDelete(assets, capped, "1.zip", NOW);
      expect(ids(deleted)).toEqual([3]); // only the oldest protected; ephemerals untouched
    });

    it("keeps the just-uploaded protected snapshot even past the cap", () => {
      // Upload #4 (the oldest by age) this run: it must survive despite a cap of 2.
      const assets = [
        snap(1, 1, { protected: true }),
        snap(2, 2, { protected: true }),
        snap(3, 3, { protected: true }),
        snap(4, 4, { protected: true }),
      ];
      const deleted = selectAssetsToDelete(assets, capped, "4.zip", NOW);
      expect(ids(deleted)).toEqual([3]); // #4 protected from deletion; #3 still collected
    });

    it("caps both pools independently", () => {
      const both = { retentionDays: 3650, retentionCount: 1, protectedRetentionCount: 1, pathPrefix: "" };
      const assets = [snap(1, 1, { protected: true }), snap(2, 3, { protected: true }), snap(10, 2), snap(11, 4)];
      const deleted = selectAssetsToDelete(assets, both, "1.zip", NOW);
      // protected: keep newest 1 (#1) → drop #2; ephemeral: keep newest 1 (#10) → drop #11
      expect(ids(deleted)).toEqual([2, 11]);
    });
  });
});
