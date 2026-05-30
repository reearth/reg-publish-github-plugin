import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TAG_NAME,
  assetNameForKey,
  keyFromAssetName,
  parseBoolEnv,
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
  const OLD_TOKEN = process.env.GITHUB_TOKEN;
  const OLD_ACTOR = process.env.GITHUB_ACTOR;
  const OLD_PROTECTED = process.env.REG_PUBLISH_PROTECTED;
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
    delete process.env.GITHUB_ACTOR;
    delete process.env.REG_PUBLISH_PROTECTED;
  });
  afterEach(() => {
    if (OLD_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = OLD_TOKEN;
    if (OLD_ACTOR === undefined) delete process.env.GITHUB_ACTOR;
    else process.env.GITHUB_ACTOR = OLD_ACTOR;
    if (OLD_PROTECTED === undefined) delete process.env.REG_PUBLISH_PROTECTED;
    else process.env.REG_PUBLISH_PROTECTED = OLD_PROTECTED;
  });

  it("applies defaults", () => {
    const resolved = resolveConfig({ repository: "owner/repo" });
    expect(resolved).toMatchObject({
      backend: "releases",
      owner: "owner",
      repo: "repo",
      tagName: DEFAULT_TAG_NAME,
      token: "test-token",
      pathPrefix: "",
      retentionDays: DEFAULT_RETENTION_DAYS,
      registry: "ghcr.io",
      username: "owner",
    });
    expect(resolved.retentionCount).toBeUndefined();
  });

  it("resolves the ghcr backend with registry and username defaults", () => {
    const resolved = resolveConfig({ backend: "ghcr", repository: "acme/widgets" });
    expect(resolved.backend).toBe("ghcr");
    expect(resolved.registry).toBe("ghcr.io");
    expect(resolved.username).toBe("acme"); // falls back to owner
  });

  it("honours an explicit registry and username for ghcr", () => {
    const resolved = resolveConfig({
      backend: "ghcr",
      repository: "acme/widgets",
      registry: "ghcr.example.com",
      username: "ci-bot",
    });
    expect(resolved).toMatchObject({ backend: "ghcr", registry: "ghcr.example.com", username: "ci-bot" });
  });

  it("rejects an unknown backend", () => {
    expect(() => resolveConfig({ repository: "o/r", backend: "s3" as never })).toThrow(/backend must be/);
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
      backend: "releases",
      owner: "o",
      repo: "r",
      tagName: "snaps",
      token: "tok",
      pathPrefix: "p-",
      retentionDays: 7,
      retentionCount: 50,
      protected: false,
      registry: "ghcr.io",
      username: "o",
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

  it("defaults protected to false", () => {
    expect(resolveConfig({ repository: "o/r" }).protected).toBe(false);
  });

  it("honours protected from config", () => {
    expect(resolveConfig({ repository: "o/r", protected: true }).protected).toBe(true);
  });

  it("lets REG_PUBLISH_PROTECTED override the config", () => {
    process.env.REG_PUBLISH_PROTECTED = "true";
    expect(resolveConfig({ repository: "o/r", protected: false }).protected).toBe(true);

    process.env.REG_PUBLISH_PROTECTED = "false";
    expect(resolveConfig({ repository: "o/r", protected: true }).protected).toBe(false);
  });

  it("falls back to config when REG_PUBLISH_PROTECTED is empty", () => {
    process.env.REG_PUBLISH_PROTECTED = "";
    expect(resolveConfig({ repository: "o/r", protected: true }).protected).toBe(true);
  });
});

describe("parseBoolEnv", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["yes", true],
    ["0", false],
    ["false", false],
    ["no", false],
    ["anything", false],
  ])("parses %s", (input, expected) => {
    expect(parseBoolEnv(input)).toBe(expected);
  });

  it("returns undefined for unset or empty", () => {
    expect(parseBoolEnv(undefined)).toBeUndefined();
    expect(parseBoolEnv("")).toBeUndefined();
    expect(parseBoolEnv("   ")).toBeUndefined();
  });
});
