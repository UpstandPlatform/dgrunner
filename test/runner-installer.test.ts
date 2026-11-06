import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { extractArchiveMock } = vi.hoisted(() => ({
  extractArchiveMock: vi.fn(),
}));

vi.mock("../src/utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/fs.js")>();
  return { ...actual, extractArchive: extractArchiveMock };
});

import {
  downloadAndInstallRunner,
  getPlatformKey,
  resolveRunnerPackage,
} from "../src/core/runner-installer.js";
import {
  FALLBACK_CHECKSUMS,
  FALLBACK_RUNNER_VERSION,
} from "../src/config/constants.js";

function makeRelease(version: string, digest: string, downloadUrl?: string) {
  const extension = process.platform === "win32" ? "zip" : "tar.gz";
  const fileName = "actions-runner-" + getPlatformKey() + "-" + version + "." + extension;
  return {
    tag_name: "v" + version,
    body: "",
    assets: [{
      name: fileName,
      digest: "sha256:" + digest,
      browser_download_url: downloadUrl ||
        "https://github.com/actions/runner/releases/download/v" + version + "/" + fileName,
    }],
  };
}

function responseForRelease(release: unknown): Response {
  return new Response(JSON.stringify(release), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Runner package installer", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dgrunner-installer-"));
    extractArchiveMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it("accepts only the exact official release asset URL and SHA-256 digest", async () => {
    const archive = Buffer.from("trusted runner archive");
    const digest = crypto.createHash("sha256").update(archive).digest("hex");
    const release = makeRelease("3.1.0", digest);
    const fetchMock = vi.fn().mockResolvedValue(responseForRelease(release));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveRunnerPackage()).resolves.toMatchObject({
      version: "3.1.0",
      expectedSha256: digest,
      downloadUrl: release.assets[0]!.browser_download_url,
    });
  });

  it("falls back to the pinned, checksummed release when API metadata is untrusted", async () => {
    const response = makeRelease("3.2.0", "a".repeat(64), "https://attacker.example/runner.tar.gz");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseForRelease(response)));

    await expect(resolveRunnerPackage()).resolves.toMatchObject({
      version: FALLBACK_RUNNER_VERSION,
      expectedSha256: FALLBACK_CHECKSUMS[getPlatformKey()],
      downloadUrl: expect.stringContaining("/v" + FALLBACK_RUNNER_VERSION + "/"),
    });
  });

  it("downloads, verifies, caches, and extracts a package with a matching checksum", async () => {
    const archive = Buffer.from("trusted runner archive");
    const digest = crypto.createHash("sha256").update(archive).digest("hex");
    const release = makeRelease("3.3.0", digest);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseForRelease(release))
      .mockResolvedValueOnce(new Response(archive, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const installDir = path.join(tempDir, "runner");
    const cacheBaseDir = path.join(tempDir, "cache-root");

    await expect(downloadAndInstallRunner(installDir, undefined, cacheBaseDir)).resolves.toEqual({
      version: "3.3.0",
      installDir,
    });

    const cacheFiles = await fsPromises.readdir(path.join(cacheBaseDir, "cache"));
    const expectedArchive = "actions-runner-" + getPlatformKey() + "-3.3.0." +
      (process.platform === "win32" ? "zip" : "tar.gz");
    expect(cacheFiles).toEqual([expectedArchive]);
    expect(extractArchiveMock).toHaveBeenCalledWith(
      path.join(cacheBaseDir, "cache", cacheFiles[0]!),
      installDir,
    );
  });

  it("removes a downloaded archive when its checksum does not match", async () => {
    const release = makeRelease("3.4.0", "0".repeat(64));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseForRelease(release))
      .mockResolvedValueOnce(new Response(Buffer.from("tampered"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cacheBaseDir = path.join(tempDir, "cache-root");

    await expect(downloadAndInstallRunner(path.join(tempDir, "runner"), undefined, cacheBaseDir))
      .rejects.toThrow(/integrity check failed/i);
    await expect(fsPromises.readdir(path.join(cacheBaseDir, "cache"))).resolves.toEqual([]);
    expect(extractArchiveMock).not.toHaveBeenCalled();
  });

  it("enforces the streamed archive size limit when Content-Length is absent", async () => {
    const archive = Buffer.from("more than four bytes");
    const digest = crypto.createHash("sha256").update(archive).digest("hex");
    const release = makeRelease("3.5.0", digest);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseForRelease(release))
      .mockResolvedValueOnce(new Response(archive, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cacheBaseDir = path.join(tempDir, "cache-root");

    await expect(downloadAndInstallRunner(path.join(tempDir, "runner"), undefined, cacheBaseDir, 4))
      .rejects.toThrow(/download limit/i);
    await expect(fsPromises.readdir(path.join(cacheBaseDir, "cache"))).resolves.toEqual([]);
    expect(extractArchiveMock).not.toHaveBeenCalled();
  });
});
