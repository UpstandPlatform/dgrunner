import { Command } from "commander";
import { runUpgrade, PackageManager } from "../core/updater.js";
import { logger } from "../utils/logger.js";

export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .alias("update")
    .description("Upgrade dgrunner to the latest stable release from npm")
    .option("-c, --check", "Check for available updates without installing", false)
    .option("-f, --force", "Force re-installation even if already on the latest version", false)
    .option("-t, --tag <tag>", "npm distribution tag to install", "latest")
    .option("--package-manager <pm>", "Override package manager to use (npm, pnpm, yarn, bun)")
    .action(async (options) => {
      logger.header("dgrunner Self-Upgrade");

      let pm: PackageManager | undefined;
      if (options.packageManager) {
        const val = options.packageManager.toLowerCase();
        if (["npm", "pnpm", "yarn", "bun"].includes(val)) {
          pm = val as PackageManager;
        } else {
          logger.warn(`Unknown package manager '${options.packageManager}', falling back to auto-detection.`);
        }
      }

      const result = await runUpgrade({
        checkOnly: options.check,
        force: options.force,
        tag: options.tag,
        packageManager: pm,
      });
      if (result.error) process.exitCode = 1;
    });
}
