import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { execCommand } from "../utils/exec.js";

const SYSTEMD_UNIT_DIR = "/etc/systemd/system";
const MANAGED_MARKER = ".dgrunner-service";
const LEGACY_MARKER = ".service";

export interface LinuxServiceResult {
  success: boolean;
  message: string;
}

export interface LinuxServiceUnitResult {
  installed: boolean;
  unitName?: string;
  error?: string;
}

function isSupportedUnitName(value: string): boolean {
  return /^(?:actions\.runner\.[A-Za-z0-9_.@-]+|dgrunner-[a-f0-9]{20})\.service$/.test(value);
}

export async function readLinuxServiceUnit(runnerDir: string): Promise<LinuxServiceUnitResult> {
  for (const markerName of [MANAGED_MARKER, LEGACY_MARKER]) {
    const markerPath = path.join(runnerDir, markerName);
    let stat;
    try {
      stat = await fsPromises.lstat(markerPath);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      return { installed: true, error: error?.message || String(error) };
    }

    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { installed: true, error: "Runner service marker must be a regular file." };
    }

    try {
      const content = (await fsPromises.readFile(markerPath, "utf-8")).trim();
      const unitName = content.endsWith(".service") ? content : content + ".service";
      const expectedManagedUnit = getManagedUnitName(runnerDir);
      const validUnit = markerName === MANAGED_MARKER
        ? unitName === expectedManagedUnit
        : /^actions\.runner\.[A-Za-z0-9_.@-]+\.service$/.test(unitName);
      if (!isSupportedUnitName(unitName) || !validUnit) {
        return { installed: true, error: "Runner service marker contains an invalid systemd unit name." };
      }
      return { installed: true, unitName };
    } catch (error: any) {
      return { installed: true, error: error?.message || String(error) };
    }
  }

  return { installed: false };
}

function getManagedUnitName(runnerDir: string): string {
  const identity = path.resolve(runnerDir);
  const suffix = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 20);
  return "dgrunner-" + suffix + ".service";
}

function systemdQuoted(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Runner directory cannot contain control characters.");
  }
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';
}

function getSystemdUnitContent(runnerDir: string): string {
  if (typeof process.getuid !== "function") {
    throw new Error("Could not determine the Linux user ID for the runner service.");
  }
  const absoluteRunnerDir = path.resolve(runnerDir);
  const runServicePath = path.join(absoluteRunnerDir, "runsvc.sh");
  return [
    "[Unit]",
    "Description=dgrunner GitHub Actions Runner",
    "After=network.target",
    "",
    "[Service]",
    "ExecStart=/bin/bash " + systemdQuoted(runServicePath),
    "User=" + process.getuid(),
    "WorkingDirectory=" + systemdQuoted(absoluteRunnerDir),
    "KillMode=process",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=5min",
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

async function runSystemctl(args: string[], timeoutMs = 30000) {
  return execCommand("sudo", ["systemctl", ...args], { timeoutMs });
}

export async function getValidatedLinuxServiceUnit(runnerDir: string): Promise<LinuxServiceUnitResult> {
  const service = await readLinuxServiceUnit(runnerDir);
  if (service.error || !service.unitName) return service;

  const info = await execCommand("systemctl", [
    "show", "--property=WorkingDirectory", "--value", service.unitName,
  ], { timeoutMs: 10000 });
  if (info.exitCode !== 0 || !info.stdout.trim()) {
    return { installed: true, error: "Could not verify the runner systemd unit." };
  }
  if (path.resolve(info.stdout.trim()) !== path.resolve(runnerDir)) {
    return { installed: true, error: "Runner service unit points to a different runner directory." };
  }
  return service;
}

async function removeMarker(runnerDir: string, markerName: string): Promise<void> {
  await fsPromises.unlink(path.join(runnerDir, markerName)).catch(() => {});
}

export async function installLinuxRunnerService(runnerDir: string): Promise<LinuxServiceResult> {
  if (process.platform !== "linux") {
    return { success: false, message: "Persistent native services are supported only on Linux." };
  }

  const current = await readLinuxServiceUnit(runnerDir);
  if (current.error) return { success: false, message: current.error };
  if (current.unitName) return { success: true, message: "Runner systemd service is already installed." };

  const runServicePath = path.join(runnerDir, "runsvc.sh");
  try {
    const runServiceStat = await fsPromises.lstat(runServicePath);
    if (!runServiceStat.isFile() || runServiceStat.isSymbolicLink()) {
      return { success: false, message: "Runner runsvc.sh must be a regular file." };
    }
  } catch {
    return { success: false, message: "Runner service entry point runsvc.sh was not found." };
  }

  const unitName = getManagedUnitName(runnerDir);
  const unitPath = path.join(SYSTEMD_UNIT_DIR, unitName);
  let content: string;
  try {
    content = getSystemdUnitContent(runnerDir);
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }

  const writeUnit = await execCommand("sudo", ["tee", "--", unitPath], {
    input: content,
    timeoutMs: 30000,
  });
  if (writeUnit.exitCode !== 0) {
    await execCommand("sudo", ["rm", "-f", "--", unitPath], { timeoutMs: 30000 });
    return { success: false, message: writeUnit.stderr || writeUnit.stdout || "Could not write the systemd unit." };
  }

  const chmod = await execCommand("sudo", ["chmod", "0644", "--", unitPath], { timeoutMs: 30000 });
  const reload = chmod.exitCode === 0
    ? await runSystemctl(["daemon-reload"])
    : { exitCode: chmod.exitCode, stdout: chmod.stdout, stderr: chmod.stderr };
  const enable = reload.exitCode === 0
    ? await runSystemctl(["enable", unitName])
    : { exitCode: reload.exitCode, stdout: reload.stdout, stderr: reload.stderr };

  if (enable.exitCode !== 0) {
    await execCommand("sudo", ["rm", "-f", "--", unitPath], { timeoutMs: 30000 });
    await runSystemctl(["daemon-reload"]);
    return {
      success: false,
      message: enable.stderr || enable.stdout || "Could not enable the runner systemd service.",
    };
  }

  const markerPath = path.join(runnerDir, MANAGED_MARKER);
  try {
    await fsPromises.writeFile(markerPath, unitName + "\n", { encoding: "utf-8", flag: "wx", mode: 0o600 });
  } catch (error) {
    await runSystemctl(["disable", "--now", unitName]);
    await execCommand("sudo", ["rm", "-f", "--", unitPath], { timeoutMs: 30000 });
    await runSystemctl(["daemon-reload"]);
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return { success: true, message: "Systemd persistent service installed successfully." };
}

export async function startLinuxRunnerService(runnerDir: string): Promise<LinuxServiceResult> {
  const service = await getValidatedLinuxServiceUnit(runnerDir);
  if (service.error) return { success: false, message: service.error };
  if (!service.unitName) return { success: false, message: "Runner systemd service is not installed." };

  const result = await runSystemctl(["start", service.unitName], 120000);
  return {
    success: result.exitCode === 0,
    message: result.exitCode === 0
      ? "Runner systemd service started."
      : result.stderr || result.stdout || "Could not start the runner systemd service.",
  };
}

export async function stopLinuxRunnerService(runnerDir: string): Promise<LinuxServiceResult> {
  const service = await getValidatedLinuxServiceUnit(runnerDir);
  if (service.error) return { success: false, message: service.error };
  if (!service.unitName) return { success: true, message: "Runner systemd service is not installed." };

  const result = await runSystemctl(["stop", service.unitName], 120000);
  return {
    success: result.exitCode === 0,
    message: result.exitCode === 0
      ? "Runner systemd service stopped."
      : result.stderr || result.stdout || "Could not stop the runner systemd service.",
  };
}

export async function getLinuxRunnerServiceStatus(runnerDir: string): Promise<boolean> {
  const service = await getValidatedLinuxServiceUnit(runnerDir);
  if (!service.unitName) return false;
  const result = await execCommand("systemctl", ["is-active", service.unitName], { timeoutMs: 10000 });
  return result.exitCode === 0 && result.stdout.trim() === "active";
}

export async function uninstallLinuxRunnerService(runnerDir: string): Promise<LinuxServiceResult> {
  const service = await getValidatedLinuxServiceUnit(runnerDir);
  if (service.error) return { success: false, message: service.error };
  if (!service.unitName) return { success: true, message: "Runner systemd service is not installed." };

  const unitPath = path.join(SYSTEMD_UNIT_DIR, service.unitName);
  const disabled = await runSystemctl(["disable", "--now", service.unitName], 120000);
  if (disabled.exitCode !== 0) {
    return {
      success: false,
      message: disabled.stderr || disabled.stdout || "Could not disable the runner systemd service.",
    };
  }

  const removed = await execCommand("sudo", ["rm", "-f", "--", unitPath], { timeoutMs: 30000 });
  if (removed.exitCode !== 0) {
    return { success: false, message: removed.stderr || removed.stdout || "Could not remove the systemd unit file." };
  }

  const reloaded = await runSystemctl(["daemon-reload"]);
  if (reloaded.exitCode !== 0) {
    return {
      success: false,
      message: reloaded.stderr || reloaded.stdout || "Could not reload systemd after removing the runner service.",
    };
  }

  await removeMarker(runnerDir, MANAGED_MARKER);
  await removeMarker(runnerDir, LEGACY_MARKER);
  return { success: true, message: "Runner systemd service removed." };
}
