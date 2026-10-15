import os from "node:os";
import { execCommand } from "../utils/exec.js";

export interface DockerSecurityStatus {
  available: boolean;
  version?: string;
  osType?: string;
  isRootless: boolean;
  securityOptions: string[];
  insecureTcpSocket: boolean;
  rawError?: string;
}

/**
 * Checks if the current process is running as a superuser/administrator.
 */
export async function isSuperUser(): Promise<boolean> {
  if (process.platform === "win32") {
    // In Windows, test with 'net session' or 'fltmc', which returns 0 if elevated Admin
    const res = await execCommand("net", ["session"]);
    return res.exitCode === 0;
  }
  // POSIX (Linux / macOS)
  if (typeof process.getuid === "function") {
    return process.getuid() === 0;
  }
  return false;
}

/**
 * Checks Docker engine daemon availability and security configurations.
 */
export async function inspectDockerSecurity(): Promise<DockerSecurityStatus> {
  // Check DOCKER_HOST for insecure remote TCP
  const dockerHost = process.env.DOCKER_HOST || "";
  const insecureTcpSocket =
    dockerHost.startsWith("tcp://") &&
    !dockerHost.includes("127.0.0.1") &&
    !dockerHost.includes("localhost");

  const result = await execCommand("docker", ["info", "--format", "{{json .}}"], {
    timeoutMs: 8000,
  });

  if (result.exitCode !== 0) {
    return {
      available: false,
      isRootless: false,
      securityOptions: [],
      insecureTcpSocket,
      rawError: result.stderr || result.stdout || "Docker daemon not responding",
    };
  }

  try {
    const info = JSON.parse(result.stdout);
    const securityOptions: string[] = Array.isArray(info.SecurityOptions)
      ? info.SecurityOptions
      : [];

    const isRootless = securityOptions.some((opt) =>
      typeof opt === "string" && opt.toLowerCase().includes("rootless")
    );

    const osType = info.OSType ? String(info.OSType).toLowerCase() : undefined;

    return {
      available: true,
      version: info.ServerVersion || undefined,
      osType,
      isRootless,
      securityOptions,
      insecureTcpSocket,
    };
  } catch {
    // Fallback if JSON parse fails
    return {
      available: true,
      isRootless: result.stdout.toLowerCase().includes("rootless"),
      securityOptions: [],
      insecureTcpSocket,
    };
  }
}

/**
 * Validates that a GitHub repository or organization URL is well-formed.
 */
export function validateGitHubUrl(url: string): { valid: boolean; scope?: "repo" | "org"; error?: string } {
  if (!url || typeof url !== "string") {
    return { valid: false, error: "URL cannot be empty." };
  }

  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: "Invalid URL format. Must start with https://" };
  }

  if (parsed.protocol !== "https:") {
    return { valid: false, error: "Only HTTPS GitHub URLs are allowed for security." };
  }

  if (parsed.hostname !== "github.com" && !parsed.hostname.endsWith(".ghe.com")) {
    return { valid: false, error: "URL host must be github.com (or GitHub Enterprise Server)." };
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 1) {
    return { valid: true, scope: "org" };
  } else if (segments.length === 2) {
    return { valid: true, scope: "repo" };
  }

  return {
    valid: false,
    error: "URL must be in the form https://github.com/org or https://github.com/owner/repo",
  };
}

/**
 * Validates a GitHub Actions registration token string.
 */
export function validateRegistrationToken(token: string): { valid: boolean; error?: string } {
  if (!token || typeof token !== "string") {
    return { valid: false, error: "Registration token is required." };
  }

  const trimmed = token.trim();
  if (trimmed.length < 15) {
    return { valid: false, error: "Token appears too short to be a valid GitHub registration token." };
  }

  // Tokens should not contain spaces or control characters
  if (/[\s\r\n\t]/.test(trimmed)) {
    return { valid: false, error: "Token contains invalid whitespace characters." };
  }

  return { valid: true };
}
