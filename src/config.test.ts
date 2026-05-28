import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TAG_NAME,
  assetNameForKey,
  keyFromAssetName,
  parseRepository,
  resolveConfig,
} from "./config";

describe("parseRepository", () => {
  it.each([
    ["owner/repo", { owner: "owner", repo: "repo" }],
    ["git@github.com:owner/repo.git", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo.git", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo", { owner: "owner", repo: "repo" }],
    ["ssh://git@github.com/owner/repo.git", { owner: "owner", repo: "repo" }],
  ])("parses %s", (input, expected) => {
    expect(parseRepository(input)).toEqual(expected);
  });

  it("returns null for garbage", () => {
    expect(parseRepository("not-a-repo")).toBeNull();
  });
});

describe("asset name helpers", () => {
  it("round-trips a key without prefix", () => {
    const name = assetNameForKey("abc123");
    expect(name).toBe("abc123.zip");
    expect(keyFromAssetName(name)).toBe("abc123");
  });

  it("round-trips a key with a prefix", () => {
    const name = assetNameForKey("abc123", "ios-");
    expect(name).toBe("ios-abc123.zip");
    expect(keyFromAssetName(name, "ios-")).toBe("abc123");
  });

  it("rejects non-matching names", () => {
    expect(keyFromAssetName("v1.0.0")).toBeNull(); // not a .zip
    expect(keyFromAssetName("other.zip", "ios-")).toBeNull(); // wrong prefix
  });
});

describe("resolveConfig", () => {
  const OLD_ENV = process.env.GITHUB_TOKEN;
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
  });
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = OLD_ENV;
  });

  it("applies defaults", () => {
    const resolved = resolveConfig({ repository: "owner/repo" });
    expect(resolved).toMatchObject({
      owner: "owner",
      repo: "repo",
      tagName: DEFAULT_TAG_NAME,
      token: "test-token",
      pathPrefix: "",
      retentionDays: DEFAULT_RETENTION_DAYS,
    });
    expect(resolved.retentionCount).toBeUndefined();
  });

  it("honours explicit values", () => {
    const resolved = resolveConfig({
      repository: "o/r",
      tagName: "snaps",
      token: "tok",
      pathPrefix: "p-",
      retentionDays: 7,
      retentionCount: 50,
    });
    expect(resolved).toEqual({
      owner: "o",
      repo: "r",
      tagName: "snaps",
      token: "tok",
      pathPrefix: "p-",
      retentionDays: 7,
      retentionCount: 50,
    });
  });

  it("throws without a token", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    expect(() => resolveConfig({ repository: "o/r" })).toThrow(/no token/);
  });

  it("throws on an unparseable repository", () => {
    expect(() => resolveConfig({ repository: "garbage" })).toThrow(/could not parse/);
  });

  it("rejects non-positive retention values", () => {
    expect(() => resolveConfig({ repository: "o/r", retentionDays: 0 })).toThrow(/retentionDays/);
    expect(() => resolveConfig({ repository: "o/r", retentionCount: -1 })).toThrow(/retentionCount/);
  });
});
