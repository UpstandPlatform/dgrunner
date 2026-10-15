import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execCommand } from "./exec.js";

/**
 * Ensure directory exists with secure permissions (0700 on POSIX).
 */
export async function ensureDir(dirPath: string, mode = 0o700): Promise<void> {
  if (!fs.existsSync(dirPath)) {
    await fsPromises.mkdir(dirPath, { recursive: true, mode });
  }
  // If on Linux/POSIX, enforce permissions
  if (process.platform !== "win32") {
    try {
      await fsPromises.chmod(dirPath, mode);
    } catch {
      // Ignore if chmod fails due to container / mount restrictions
    }
  }
}

/**
 * Computes the SHA-256 hash of a file.
 */
export async function calculateSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

/**
 * Extracts a tar.gz or zip archive to the target destination directory.
 */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await ensureDir(destDir);

  const ext = path.extname(archivePath).toLowerCase();
  const isTarGz = archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz");

  if (isTarGz) {
    const result = await execCommand("tar", ["-xzf", archivePath, "-C", destDir]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to extract tar.gz archive: ${result.stderr || result.stdout}`);
    }
  } else if (ext === ".zip") {
    if (process.platform === "win32") {
      // Try tar.exe first (available in Windows 10/11)
      const tarResult = await execCommand("tar", ["-xf", archivePath, "-C", destDir]);
      if (tarResult.exitCode !== 0) {
        // Fallback to PowerShell Expand-Archive
        const psCmd = `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`;
        const psResult = await execCommand("powershell", ["-NoProfile", "-Command", psCmd]);
        if (psResult.exitCode !== 0) {
          throw new Error(`Failed to extract zip archive: ${psResult.stderr || psResult.stdout}`);
        }
      }
    } else {
      const result = await execCommand("unzip", ["-q", "-o", archivePath, "-d", destDir]);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to extract zip archive: ${result.stderr || result.stdout}`);
      }
    }
  } else {
    throw new Error(`Unsupported archive format: ${archivePath}`);
  }
}

/**
 * Get available free disk space in bytes for a given path.
 */
export async function getFreeDiskBytes(checkPath: string): Promise<number | null> {
  try {
    const target = fs.existsSync(checkPath) ? checkPath : path.dirname(checkPath);
    if (typeof fsPromises.statfs === "function") {
      const stats = await fsPromises.statfs(target);
      return stats.bavail * stats.bsize;
    }
  } catch {
    // If statfs fails or is unavailable on platform
  }
  return null;
}
