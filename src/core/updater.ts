import pc from "picocolors";
import { APP_VERSION, NPM_PACKAGE_NAME } from "../config/constants.js";
import { execCommand, execInteractive } from "../utils/exec.js";
import { logger } from "../utils/logger.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface UpgradeOptions {
  checkOnly?: boolean;
  force?: boolean;
  tag?: string;
  packageManager?: PackageManager;
}

export interface UpgradeResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  upgraded: boolean;
  error?: string;
}

/**
 * Compares two semver strings (e.g. "1.0.0" vs "1.0.1").
 * Returns:
 *   1 if v1 > v2
 *  -1 if v1 < v2
 *   0 if v1 === v2
 */
export function compareSemver(v1: string, v2: string): number {
  const parse = (version: string) => {
    const match = version.trim().match(
      /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
    );
    if (!match) return null;
    return {
      core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
      prerelease: match[4]?.split(".") ?? null,
    };
  };

  const left = parse(v1);
  const right = parse(v2);
  if (!left || !right) return 0;

  for (let index = 0; index < 3; index++) {
    if (left.core[index] > right.core[index]) return 1;
    if (left.core[index] < right.core[index]) return -1;
  }

  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease || !right.prerelease) return 0;

  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index++) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return BigInt(a) > BigInt(b) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }

  return left.prerelease.length === right.prerelease.length
    ? 0
    : left.prerelease.length > right.prerelease.length ? 1 : -1;
}

/**
 * Fetches the latest released version of the package from the npm registry.
 */
export async function fetchLatestVersion(tag = "latest"): Promise<string | null> {
  // 1. Try HTTP request directly to npm registry
  try {
    const url = `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/${encodeURIComponent(tag)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "dgrunner-updater" },
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const data: any = await res.json();
      if (data?.version) return data.version;
    }
  } catch {}

  // 2. Fallback to npm view command
  try {
    const res = await execCommand("npm", ["view", `${NPM_PACKAGE_NAME}@${tag}`, "version"], {
      timeoutMs: 8000,
    });
    if (res.exitCode === 0 && res.stdout.trim()) {
      const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
      const v = lines[lines.length - 1].trim();
      if (v && /^\d+\.\d+\.\d+/.test(v)) {
        return v;
      }
    }
  } catch {}

  return null;
}

/**
 * Detects the active package manager based on execution environment.
 */
export function detectPackageManager(): PackageManager {
  const scriptPath = (process.argv[1] || "").toLowerCase();
  const userAgent = (process.env.npm_config_user_agent || "").toLowerCase();

  if (userAgent.includes("pnpm") || scriptPath.includes("pnpm")) return "pnpm";
  if (userAgent.includes("yarn") || scriptPath.includes("yarn")) return "yarn";
  if (userAgent.includes("bun") || scriptPath.includes("bun")) return "bun";
  return "npm";
}

/**
 * Detects if the current CLI process was invoked via npx.
 */
export function isRunningViaNpx(): boolean {
  const scriptPath = (process.argv[1] || "").toLowerCase();
  const execPath = (process.env._ || "").toLowerCase();

  return (
    scriptPath.includes("_npx") ||
    scriptPath.includes(".npm/_npx") ||
    scriptPath.includes("npm-cache") ||
    execPath.includes("npx")
  );
}

/**
 * Constructs the upgrade command and arguments for the chosen package manager.
 */
export function getUpgradeCommand(
  pm: PackageManager,
  tag = "latest"
): { command: string; args: string[]; display: string } {
  const pkg = `${NPM_PACKAGE_NAME}@${tag}`;
  let command = "npm";
  let args: string[] = [];

  switch (pm) {
    case "pnpm":
      command = "pnpm";
      args = ["add", "-g", pkg];
      break;
    case "yarn":
      command = "yarn";
      args = ["global", "add", pkg];
      break;
    case "bun":
      command = "bun";
      args = ["add", "-g", pkg];
      break;
    case "npm":
    default:
      command = "npm";
      args = ["install", "-g", pkg];
      break;
  }

  return {
    command,
    args,
    display: `${command} ${args.join(" ")}`,
  };
}

/**
 * Checks for updates and returns version comparison details.
 */
export async function checkForUpdates(tag = "latest"): Promise<{
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
}> {
  const currentVersion = APP_VERSION;
  const latestVersion = await fetchLatestVersion(tag);

  const updateAvailable = latestVersion
    ? compareSemver(latestVersion, currentVersion) > 0
    : false;

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
  };
}

/**
 * Performs self-upgrade to the latest package version on npm.
 */
export async function runUpgrade(options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const currentVersion = APP_VERSION;
  const tag = options.tag || "latest";

  logger.info(`Checking npm registry for ${pc.bold(NPM_PACKAGE_NAME)} updates...`);

  const latestVersion = await fetchLatestVersion(tag);

  if (!latestVersion) {
    logger.error("Could not fetch latest version information from npm registry.");
    logger.info("Check your internet connection or run: " + pc.cyan(`npm view ${NPM_PACKAGE_NAME} version`));
    return {
      currentVersion,
      latestVersion: "unknown",
      updateAvailable: false,
      upgraded: false,
      error: "Registry unreachable",
    };
  }

  const comparison = compareSemver(latestVersion, currentVersion);
  const updateAvailable = comparison > 0;

  console.log(`  Current version: ${pc.bold(currentVersion)}`);
  console.log(`  Latest version:  ${pc.bold(latestVersion)} (${tag})`);
  console.log();

  if (options.checkOnly) {
    if (updateAvailable) {
      logger.warn(`Update available! ${pc.dim(currentVersion)} → ${pc.green(latestVersion)}`);
      console.log(`  Run ${pc.cyan("dgrunner upgrade")} to install the latest version.\n`);
    } else {
      logger.success(`You are already running the latest version (v${currentVersion}).\n`);
    }
    return {
      currentVersion,
      latestVersion,
      updateAvailable,
      upgraded: false,
    };
  }

  if (!updateAvailable && !options.force) {
    logger.success(`You are already using the latest stable version of ${pc.bold(NPM_PACKAGE_NAME)} (v${currentVersion}).`);
    console.log(pc.dim("  Tip: To reinstall anyway, run: ") + pc.cyan("dgrunner upgrade --force\n"));
    return {
      currentVersion,
      latestVersion,
      updateAvailable: false,
      upgraded: false,
    };
  }

  const pm = options.packageManager || detectPackageManager();
  const upgradeCmd = getUpgradeCommand(pm, tag);

  if (isRunningViaNpx()) {
    logger.warn("You appear to be running dgrunner via npx.");
    console.log(pc.dim("  To execute the new release directly with npx:"));
    console.log(`  ${pc.cyan(`npx ${NPM_PACKAGE_NAME}@${tag}`)}\n`);
    console.log(pc.dim("  Or install globally with:"));
    console.log(`  ${pc.cyan(upgradeCmd.display)}\n`);
  }

  logger.step(1, 1, `Upgrading ${NPM_PACKAGE_NAME} from v${currentVersion} to v${latestVersion}...`);
  logger.info(`Running: ${pc.cyan(upgradeCmd.display)}`);

  const res = await execCommand(upgradeCmd.command, upgradeCmd.args, {
    timeoutMs: 120000,
  });

  if (res.exitCode !== 0) {
    const fullErr = `${res.stderr}\n${res.stdout}`.toLowerCase();
    const isPermissionError =
      fullErr.includes("eacces") ||
      fullErr.includes("eperm") ||
      fullErr.includes("operation not permitted") ||
      fullErr.includes("access is denied");

    logger.error(`Upgrade failed with exit code ${res.exitCode}.`);

    if (isPermissionError) {
      if (process.platform === "win32") {
        logger.securityAlert(
          "Administrator privileges required to update global packages on Windows.\n" +
          "Open an elevated PowerShell/Command Prompt (Run as Administrator) and run:\n" +
          pc.cyan(`  ${upgradeCmd.display}`)
        );
      } else {
        logger.securityAlert(
          "Root/sudo privileges required to update global packages on Linux.\n" +
          "Run with sudo:\n" +
          pc.cyan(`  sudo ${upgradeCmd.display}`)
        );
      }
    } else {
      console.error(res.stderr || res.stdout);
    }

    return {
      currentVersion,
      latestVersion,
      updateAvailable,
      upgraded: false,
      error: res.stderr || res.stdout,
    };
  }

  logger.success(`Successfully upgraded ${pc.bold(NPM_PACKAGE_NAME)} to ${pc.green(`v${latestVersion}`)}!`);
  console.log(pc.dim("\nVerify the new version by running: ") + pc.cyan("dgrunner --version\n"));

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    upgraded: true,
  };
}
