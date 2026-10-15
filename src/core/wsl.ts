import os from "node:os";
import fs from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface LinuxDistroInfo {
  id: string;
  name: string;
  version?: string;
}

/**
 * Checks if the current process is running inside Windows Subsystem for Linux (WSL).
 */
export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const release = os.release().toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

/**
 * Detects the Linux distribution inside a Linux or WSL environment by reading /etc/os-release.
 */
export async function detectLinuxDistro(): Promise<LinuxDistroInfo | null> {
  if (process.platform !== "linux") return null;

  try {
    const content = await fs.readFile("/etc/os-release", "utf-8");
    const lines = content.split(/\r?\n/);
    const data: Record<string, string> = {};

    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)="?(.*?)"?$/);
      if (match && match[1] && match[2] !== undefined) {
        data[match[1]] = match[2];
      }
    }

    return {
      id: (data.ID || "linux").toLowerCase(),
      name: data.PRETTY_NAME || data.NAME || "Linux",
      version: data.VERSION_ID,
    };
  } catch {
    return null;
  }
}

/**
 * Lists installed WSL distributions on Windows, filtering out internal docker-desktop distros.
 */
export async function getInstalledWslDistros(): Promise<string[]> {
  if (process.platform !== "win32") return [];

  try {
    const { stdout } = await execAsync("wsl.exe -l -q", { encoding: "buffer", timeout: 5000 });
    const text = stdout.toString("utf16le");
    const distros = text
      .split(/\r?\n/)
      .map((s) => s.trim().replace(/\0/g, ""))
      .filter((s) => s.length > 0 && !s.toLowerCase().includes("docker-desktop"));
    return distros;
  } catch {
    return [];
  }
}

/**
 * Lists valid online Linux distributions that can be installed in WSL2 via Microsoft.
 */
export async function getAvailableOnlineWslDistros(): Promise<string[]> {
  if (process.platform !== "win32") return [];

  try {
    const { stdout } = await execAsync("wsl.exe -l -o", { encoding: "buffer", timeout: 5000 });
    const text = stdout.toString("utf16le");
    const lines = text.split(/\r?\n/).map((s) => s.trim().replace(/\0/g, ""));
    const distros: string[] = [];
    let startParsing = false;

    for (const line of lines) {
      if (line.includes("NAME") && line.includes("FRIENDLY NAME")) {
        startParsing = true;
        continue;
      }
      if (startParsing && line) {
        const parts = line.split(/\s+/);
        if (parts[0]) distros.push(parts[0]);
      }
    }

    return distros.length > 0
      ? distros
      : ["Ubuntu-24.04", "Ubuntu-22.04", "Debian", "kali-linux", "openSUSE-Leap-16.0", "archlinux"];
  } catch {
    return ["Ubuntu-24.04", "Ubuntu-22.04", "Debian", "kali-linux", "openSUSE-Leap-16.0", "archlinux"];
  }
}
