import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unzipToDir, zipDir } from "./zip";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reg-zip-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("zip round-trip", () => {
  it("restores identical files, including nested ones", () => {
    const src = path.join(tmp, "src");
    fs.mkdirSync(path.join(src, "nested"), { recursive: true });
    fs.writeFileSync(path.join(src, "a.png"), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(src, "nested", "b.txt"), "hello");

    const buffer = zipDir(src);
    const dest = path.join(tmp, "dest");
    const files = unzipToDir(buffer, dest);

    expect(files.sort()).toEqual(["a.png", "nested/b.txt"]);
    expect(fs.readFileSync(path.join(dest, "a.png"))).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(fs.readFileSync(path.join(dest, "nested", "b.txt"), "utf8")).toBe("hello");
  });

  it("produces a valid empty zip for a missing directory", () => {
    const buffer = zipDir(path.join(tmp, "does-not-exist"));
    const dest = path.join(tmp, "dest");
    expect(unzipToDir(buffer, dest)).toEqual([]);
    expect(fs.existsSync(dest)).toBe(true);
  });
});
