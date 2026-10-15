import os from "node:os";
import { execCommand } from "../utils/exec.js";
import { getFreeDiskBytes } from "../utils/fs.js";
import { DEFAULT_BASE_DIR, MINIMUM_FREE_DISK_BYTES } from "../config/constants.js";
import { inspectDockerSecurity, isSuperUser } from "./security.js";
import { resolveGitBashDir } from "./runner-manager.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  message: string;
  detail?: string;
  remediation?: string;
}

export interface DoctorReport {
  ok: boolean;
  hasErrors: boolean;
  hasWarnings: boolean;
  checks: CheckResult[];
}

export async function runDoctorChecks(targetDir = DEFAULT_BASE_DIR): Promise<DoctorReport> {
  const checks: CheckResult[] = [];

  // 1. Platform & Architecture
  const platform = process.platform;
  const arch = process.arch;
  const isSupportedPlatform =
    (platform === "linux" && (arch === "x64" || arch === "arm64")) ||
    (platform === "win32" && (arch === "x64" || arch === "arm64"));

  if (isSupportedPlatform) {
    checks.push({
      id: "platform",
      name: "Operating System & Architecture",
      status: "pass",
      message: `Supported platform: ${platform} (${arch})`,
    });
  } else {
    checks.push({
      id: "platform",
      name: "Operating System & Architecture",
      status: "fail",
      message: `Unsupported platform or architecture: ${platform} (${arch})`,
      detail: "Official GitHub Actions runner binaries support Linux (x64/arm64) and Windows (x64).",
    });
  }

  // 2. User Privileges Check
  const superUser = await isSuperUser();
  if (platform === "linux") {
    if (superUser) {
      checks.push({
        id: "privileges",
        name: "User Privilege Isolation",
        status: "fail",
        message: "Running as root! Self-hosted runners must not run as root.",
        detail: "A workflow executed with root privileges can permanently compromise your host machine.",
        remediation: "Create a dedicated unprivileged user (e.g. 'actions-runner') and run dgrunner under that account.",
      });
    } else {
      checks.push({
        id: "privileges",
        name: "User Privilege Isolation",
        status: "pass",
        message: `Running as non-root user (${os.userInfo().username})`,
      });
    }
  } else if (platform === "win32") {
    if (superUser) {
      checks.push({
        id: "privileges",
        name: "User Privilege Isolation",
        status: "warn",
        message: "Running in elevated Administrator shell.",
        detail: "For security isolation, standard user permissions are recommended unless configuring system-wide services.",
      });
    } else {
      checks.push({
        id: "privileges",
        name: "User Privilege Isolation",
        status: "pass",
        message: `Running as standard user (${os.userInfo().username})`,
      });
    }
  }

  // 3. Git Check
  const gitRes = await execCommand("git", ["--version"]);
  if (gitRes.exitCode === 0) {
    checks.push({
      id: "git",
      name: "Git Version Control",
      status: "pass",
      message: `Installed (${gitRes.stdout})`,
    });

    if (platform === "win32") {
      const gitBashDir = await resolveGitBashDir();
      if (gitBashDir) {
        checks.push({
          id: "git-bash",
          name: "Git Bash Shell (Windows)",
          status: "pass",
          message: `Git Bash detected at ${gitBashDir}`,
          detail: "dgrunner automatically configures the runner environment to prioritize Git Bash over WSL bash.",
        });
      } else {
        checks.push({
          id: "git-bash",
          name: "Git Bash Shell (Windows)",
          status: "warn",
          message: "Git Bash (bash.exe) not found in standard Git directories.",
          detail: "Workflows using 'shell: bash' on Windows may fail if WSL bash is invoked with Windows paths.",
          remediation: "Ensure Git for Windows is installed with Git Bash from https://git-scm.com.",
        });
      }
    }
  } else {
    checks.push({
      id: "git",
      name: "Git Version Control",
      status: "fail",
      message: "Git is not installed or not in system PATH.",
      remediation: "Install Git from https://git-scm.com and ensure it is available in PATH.",
    });
  }

  // 4. Docker Installation & Security
  const dockerSec = await inspectDockerSecurity();
  if (!dockerSec.available) {
    checks.push({
      id: "docker",
      name: "Docker Engine",
      status: "fail",
      message: "Docker daemon is not running or not accessible.",
      detail: dockerSec.rawError,
      remediation: "Start Docker Desktop or the dockerd service and verify 'docker info' succeeds.",
    });
  } else {
    checks.push({
      id: "docker",
      name: "Docker Engine",
      status: "pass",
      message: `Docker engine active (v${dockerSec.version || "unknown"})`,
    });

    if (dockerSec.insecureTcpSocket) {
      checks.push({
        id: "docker-socket",
        name: "Docker Socket Security",
        status: "fail",
        message: "Docker is configured to expose an unauthenticated remote TCP socket!",
        detail: "Anyone with network access can execute arbitrary containers on your machine.",
        remediation: "Unset DOCKER_HOST or bind Docker daemon only to local pipes/sockets or TLS.",
      });
    }

    if (platform === "linux") {
      if (dockerSec.isRootless) {
        checks.push({
          id: "docker-rootless",
          name: "Rootless Docker Isolation",
          status: "pass",
          message: "Rootless Docker is enabled (workflows cannot escape to host root)",
        });
      } else {
        checks.push({
          id: "docker-rootless",
          name: "Rootless Docker Isolation",
          status: "fail",
          message: "Docker daemon is running in root mode.",
          detail:
            "On Linux, container workflows with Docker access can manipulate the host filesystem as root.",
          remediation:
            "Install rootless Docker: run 'dockerd-rootless-setuptool.sh install' (or override with --force if acceptable).",
        });
      }
    }
  }

  // 5. GitHub Network Connectivity
  try {
    const start = Date.now();
    const res = await fetch("https://api.github.com/zen", {
      headers: { "User-Agent": "dgrunner" },
      signal: AbortSignal.timeout(6000),
    });
    const latency = Date.now() - start;
    if (res.ok) {
      checks.push({
        id: "github-network",
        name: "GitHub API Reachability",
        status: "pass",
        message: `Connected successfully (${latency}ms latency)`,
      });
    } else {
      checks.push({
        id: "github-network",
        name: "GitHub API Reachability",
        status: "warn",
        message: `HTTP ${res.status} received from GitHub API`,
      });
    }
  } catch (err: any) {
    checks.push({
      id: "github-network",
      name: "GitHub API Reachability",
      status: "fail",
      message: "Failed to connect to https://api.github.com",
      detail: err?.message || String(err),
      remediation: "Check internet connection, DNS resolution, and firewall or proxy settings.",
    });
  }

  // 6. Free Disk Space
  const freeBytes = await getFreeDiskBytes(targetDir);
  if (freeBytes !== null) {
    const freeGb = (freeBytes / (1024 * 1024 * 1024)).toFixed(1);
    if (freeBytes >= MINIMUM_FREE_DISK_BYTES) {
      checks.push({
        id: "disk-space",
        name: "Disk Space Availability",
        status: "pass",
        message: `${freeGb} GB free in ${targetDir}`,
      });
    } else {
      checks.push({
        id: "disk-space",
        name: "Disk Space Availability",
        status: "warn",
        message: `Only ${freeGb} GB free (at least 5 GB recommended for Docker images & workflows)`,
      });
    }
  }

  const hasErrors = checks.some((c) => c.status === "fail");
  const hasWarnings = checks.some((c) => c.status === "warn");

  return {
    ok: !hasErrors,
    hasErrors,
    hasWarnings,
    checks,
  };
}
