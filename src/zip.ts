import fs from "fs";

import AdmZip from "adm-zip";

/**
 * Zip the contents of `dir` into an in-memory buffer. Entries are stored with
 * paths relative to `dir` (no leading directory component). A missing or empty
 * directory yields a valid, empty zip.
 */
export function zipDir(dir: string): Buffer {
  const zip = new AdmZip();
  if (fs.existsSync(dir)) {
    zip.addLocalFolder(dir);
  }
  return zip.toBuffer();
}

/**
 * Extract every file from a zip buffer into `destDir`, creating it if needed.
 * Existing files are overwritten. Returns the relative paths of the extracted
 * files (directories excluded).
 */
export function unzipToDir(buffer: Buffer, destDir: string): string[] {
  fs.mkdirSync(destDir, { recursive: true });
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  zip.extractAllTo(destDir, /* overwrite */ true);
  return entries.filter(e => !e.isDirectory).map(e => e.entryName);
}
