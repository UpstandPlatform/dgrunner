import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { calculateSha256, ensureDir, getFreeDiskBytes } from "../src/utils/fs.js";

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
});
