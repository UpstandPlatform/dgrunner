import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DEFAULT_BASE_DIR,
  DEFAULT_RUNNER_DIR,
  FALLBACK_CHECKSUMS,
  FALLBACK_RUNNER_VERSION,
  GITHUB_RUNNER_REPO,
} from "../config/constants.js";
import { calculateSha256, ensureDir, extractArchive } from "../utils/fs.js";
import { logger } from "../utils/logger.js";

export interface RunnerPackageInfo {
  platformKey: string;
  version: string;
  fileName: string;
  downloadUrl: string;
  expectedSha256: string;
}

export function getPlatformKey(): string {
  const platform = process.platform === "win32" ? "win" : process.platform;
  const arch = process.arch;
  return `${platform}-${arch}`;
}

/**
 * Resolves the runner package download URL and SHA-256 hash.
 */
export async function resolveRunnerPackage(): Promise<RunnerPackageInfo> {
  const platformKey = getPlatformKey();
  const ext = process.platform === "win32" ? "zip" : "tar.gz";

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_RUNNER_REPO}/releases/latest`, {
      headers: { "User-Agent": "dgrunner" },
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      const data: unknown = await res.json();
      const release = data as {
        tag_name?: unknown;
        body?: unknown;
        assets?: Array<{ name?: unknown; digest?: unknown; browser_download_url?: unknown }>;
      };
      const tagName = typeof release.tag_name === "string" ? release.tag_name : "";
      const versionMatch = tagName.match(/^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
      const version = versionMatch?.[1];
      const fileName = version ? `actions-runner-${platformKey}-${version}.${ext}` : "";
      const asset = release.assets?.find((candidate) => candidate.name === fileName);

      if (version && asset) {
        const digest = typeof asset.digest === "string"
          ? asset.digest.match(/^sha256:([a-fA-F0-9]{64})$/)?.[1]
          : undefined;
        const body = typeof release.body === "string" ? release.body : "";
        const checksumMatch = body.match(
          new RegExp(`<!-- BEGIN SHA ${platformKey} -->\\s*([a-fA-F0-9]{64})\\s*<!-- END SHA`, "i")
        );
        const expectedSha256 = (digest || checksumMatch?.[1] ||
          (version === FALLBACK_RUNNER_VERSION ? FALLBACK_CHECKSUMS[platformKey] : undefined))?.toLowerCase();
        const downloadUrl = typeof asset.browser_download_url === "string"
          ? asset.browser_download_url
          : "";

        if (expectedSha256 && isOfficialRunnerAssetUrl(downloadUrl, tagName, fileName)) {
          return { platformKey, version, fileName, downloadUrl, expectedSha256 };
        }
      }
    }
  } catch {
    // Network / API rate limit fallback
  }

  // Fallback to pinned version
  const expectedSha256 = FALLBACK_CHECKSUMS[platformKey];
  if (!expectedSha256) {
    throw new Error(`No trusted SHA-256 checksum is available for the ${platformKey} runner package.`);
  }

  const fileName = `actions-runner-${platformKey}-${FALLBACK_RUNNER_VERSION}.${ext}`;
  const downloadUrl = `https://github.com/${GITHUB_RUNNER_REPO}/releases/download/v${FALLBACK_RUNNER_VERSION}/${fileName}`;

  return {
    platformKey,
    version: FALLBACK_RUNNER_VERSION,
    fileName,
    downloadUrl,
    expectedSha256,
  };
}

function isOfficialRunnerAssetUrl(url: string, tagName: string, fileName: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.pathname === `/actions/runner/releases/download/${tagName}/${fileName}`;
  } catch {
    return false;
  }
}

/**
 * Downloads and verifies the runner package, then extracts it into destDir.
 */
export async function downloadAndInstallRunner(
  destDir = DEFAULT_RUNNER_DIR,
  onProgress?: (msg: string) => void
): Promise<{ version: string; installDir: string }> {
  await ensureDir(destDir);

  const pkg = await resolveRunnerPackage();
  onProgress?.(`Found official runner release v${pkg.version} for ${pkg.platformKey}`);

  const cacheDir = path.join(DEFAULT_BASE_DIR, "cache");
  await ensureDir(cacheDir);

  const archivePath = path.join(cacheDir, pkg.fileName);
  const temporaryArchivePath = `${archivePath}.${process.pid}.${Date.now()}.tmp`;

  // If archive already exists and matches hash, avoid re-download
  let needDownload = true;
  if (fs.existsSync(archivePath)) {
    const existingHash = await calculateSha256(archivePath);
    if (existingHash.toLowerCase() === pkg.expectedSha256) {
      onProgress?.("Verified cached runner archive integrity via SHA-256.");
      needDownload = false;
    } else {
      await fsPromises.unlink(archivePath).catch(() => {});
    }
  }

  if (needDownload) {
    onProgress?.(`Downloading ${pkg.fileName} from GitHub Releases...`);
    const res = await fetch(pkg.downloadUrl, {
      headers: { "User-Agent": "dgrunner" },
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Failed to download runner package from ${pkg.downloadUrl}: HTTP ${res.status}`);
    }

    try {
      const fileStream = fs.createWriteStream(temporaryArchivePath, { flags: "wx", mode: 0o600 });
      await pipeline(Readable.fromWeb(res.body as any), fileStream);
      onProgress?.("Download complete.");

      onProgress?.("Verifying SHA-256 package checksum...");
      const actualSha256 = await calculateSha256(temporaryArchivePath);
      if (actualSha256.toLowerCase() !== pkg.expectedSha256) {
        throw new Error(
          `Security integrity check failed! Expected SHA-256: ${pkg.expectedSha256}, got: ${actualSha256}. Download removed.`
        );
      }
      await fsPromises.rename(temporaryArchivePath, archivePath);
      onProgress?.("Checksum verified successfully.");
    } catch (error) {
      await fsPromises.unlink(temporaryArchivePath).catch(() => {});
      throw error;
    }
  }

  onProgress?.(`Extracting runner to ${destDir}...`);
  await extractArchive(archivePath, destDir);
  onProgress?.("Runner files extracted successfully.");

  return {
    version: pkg.version,
    installDir: destDir,
  };
}
