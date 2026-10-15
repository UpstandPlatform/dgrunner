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
  expectedSha256?: string;
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
      const data: any = await res.json();
      const tagName: string = data.tag_name || `v${FALLBACK_RUNNER_VERSION}`;
      const version = tagName.replace(/^v/, "");

      // Look for asset matching platformKey
      const asset = (data.assets || []).find((a: any) =>
        a.name && a.name.includes(platformKey) && a.name.endsWith(`.${ext}`)
      );

      if (asset) {
        // Try to parse sha256 from release body if present
        let expectedSha256 = FALLBACK_CHECKSUMS[platformKey];
        const body: string = data.body || "";
        // Match patterns like <!-- BEGIN SHA linux-x64 -->HASH<!-- END SHA linux-x64 --> or asset sha256
        const shaRegex = new RegExp(`<!-- BEGIN SHA ${platformKey} -->\\s*([a-fA-F0-9]{64})\\s*<!-- END SHA`, "i");
        const match = body.match(shaRegex);
        if (match && match[1]) {
          expectedSha256 = match[1].toLowerCase();
        }

        return {
          platformKey,
          version,
          fileName: asset.name,
          downloadUrl: asset.browser_download_url,
          expectedSha256,
        };
      }
    }
  } catch {
    // Network / API rate limit fallback
  }

  // Fallback to pinned version
  const fileName = `actions-runner-${platformKey}-${FALLBACK_RUNNER_VERSION}.${ext}`;
  const downloadUrl = `https://github.com/${GITHUB_RUNNER_REPO}/releases/download/v${FALLBACK_RUNNER_VERSION}/${fileName}`;
  const expectedSha256 = FALLBACK_CHECKSUMS[platformKey];

  return {
    platformKey,
    version: FALLBACK_RUNNER_VERSION,
    fileName,
    downloadUrl,
    expectedSha256,
  };
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

  // If archive already exists and matches hash, avoid re-download
  let needDownload = true;
  if (fs.existsSync(archivePath) && pkg.expectedSha256) {
    const existingHash = await calculateSha256(archivePath);
    if (existingHash.toLowerCase() === pkg.expectedSha256.toLowerCase()) {
      onProgress?.("Verified cached runner archive integrity via SHA-256.");
      needDownload = false;
    }
  }

  if (needDownload) {
    onProgress?.(`Downloading ${pkg.fileName} from GitHub Releases...`);
    const res = await fetch(pkg.downloadUrl, {
      headers: { "User-Agent": "dgrunner" },
    });

    if (!res.ok || !res.body) {
      throw new Error(`Failed to download runner package from ${pkg.downloadUrl}: HTTP ${res.status}`);
    }

    const fileStream = fs.createWriteStream(archivePath);
    // Readable.fromWeb adapts web stream to node stream
    await pipeline(Readable.fromWeb(res.body as any), fileStream);
    onProgress?.("Download complete.");

    // Integrity check
    if (pkg.expectedSha256) {
      onProgress?.("Verifying SHA-256 package checksum...");
      const actualSha256 = await calculateSha256(archivePath);
      if (actualSha256.toLowerCase() !== pkg.expectedSha256.toLowerCase()) {
        await fsPromises.unlink(archivePath).catch(() => {});
        throw new Error(
          `Security integrity check failed! Expected SHA-256: ${pkg.expectedSha256}, got: ${actualSha256}. Download removed.`
        );
      }
      onProgress?.("Checksum verified successfully.");
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
