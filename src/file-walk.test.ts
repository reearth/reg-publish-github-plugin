import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { walkFiles } from "./file-walk";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reg-walk-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("walkFiles", () => {
  it("lists nested files with forward-slash relative paths", () => {
    fs.mkdirSync(path.join(tmp, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "root.png"), "x");
    fs.writeFileSync(path.join(tmp, "a", "b", "deep.png"), "y");

    const rels = walkFiles(tmp)
      .map(f => f.relPath)
      .sort();
    expect(rels).toEqual(["a/b/deep.png", "root.png"]);
  });

  it("returns [] for a missing directory", () => {
    expect(walkFiles(path.join(tmp, "nope"))).toEqual([]);
  });
});
