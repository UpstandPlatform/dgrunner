import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { calculateSha256, ensureDir, extractArchive, getFreeDiskBytes } from "../src/utils/fs.js";

describe("FS Utilities", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `dgrunner-test-${Date.now()}`);
    await ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should calculate correct SHA-256 hash of a file", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fsPromises.writeFile(filePath, "hello world", "utf-8");

    const hash = await calculateSha256(filePath);
    // sha256 of "hello world" is b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  it("should report non-null free disk bytes on current drive", async () => {
    const freeBytes = await getFreeDiskBytes(tmpDir);
    expect(freeBytes).not.toBeNull();
    expect(freeBytes).toBeGreaterThan(0);
  });

  it("checks disk space using the nearest existing parent of a missing nested path", async () => {
    const missingPath = path.join(tmpDir, "missing", "nested", "runner");
    const freeBytes = await getFreeDiskBytes(missingPath);
    expect(freeBytes).not.toBeNull();
    expect(freeBytes).toBeGreaterThan(0);
  });

  it("rejects an existing file where a directory is required", async () => {
    const filePath = path.join(tmpDir, "not-a-directory");
    await fsPromises.writeFile(filePath, "keep");
    await expect(ensureDir(filePath)).rejects.toThrow(/Expected a directory/);
    await expect(fsPromises.readFile(filePath, "utf-8")).resolves.toBe("keep");
  });

  it("tightens permissions on an existing POSIX data directory", async () => {
    if (process.platform === "win32") return;
    const directory = path.join(tmpDir, "existing-data");
    await fsPromises.mkdir(directory, { mode: 0o777 });
    await fsPromises.chmod(directory, 0o755);

    await ensureDir(directory);

    expect((await fsPromises.stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("rejects a malformed ZIP instead of reporting extraction success", async () => {
    const archivePath = path.join(tmpDir, "broken.zip");
    await fsPromises.writeFile(archivePath, "not a zip archive");
    await expect(extractArchive(archivePath, path.join(tmpDir, "extracted"))).rejects.toThrow(/Failed to extract zip archive/);
  });
});
