import fs from "fs";
import path from "path";

export interface WalkedFile {
  /** Path relative to the walked root, using forward slashes. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
}

/**
 * Recursively list every file under `root` (directories excluded). Relative
 * paths use forward slashes so they are stable across platforms. A missing root
 * yields an empty list.
 */
export function walkFiles(root: string): WalkedFile[] {
  if (!fs.existsSync(root)) return [];
  const out: WalkedFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath);
      } else if (entry.isFile()) {
        out.push({ relPath: path.relative(root, absPath).split(path.sep).join("/"), absPath });
      }
    }
  };
  walk(root);
  return out;
}
