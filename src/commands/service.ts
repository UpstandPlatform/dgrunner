import { Command } from "commander";
import { startService, stopService, getRunnerStatus } from "../core/runner-manager.js";
import { logger } from "../utils/logger.js";
import { DEFAULT_RUNNER_DIR } from "../config/constants.js";

export function registerServiceCommands(program: Command): void {
  program
    .command("start")
    .description("Start the persistent runner background service")
    .option("-d, --dir <path>", "Runner directory", DEFAULT_RUNNER_DIR)
    .action(async (options) => {
      logger.info("Starting runner service...");
      const res = await startService(options.dir);
      if (res.success) {
        logger.success(res.message);
      } else {
        logger.error(res.message);
        process.exit(1);
      }
    });

  program
    .command("stop")
    .description("Stop the persistent runner background service")
    .option("-d, --dir <path>", "Runner directory", DEFAULT_RUNNER_DIR)
    .action(async (options) => {
      logger.info("Stopping runner service...");
      const res = await stopService(options.dir);
      if (res.success) {
        logger.success(res.message);
      } else {
        logger.error(res.message);
        process.exit(1);
      }
    });

  program
    .command("restart")
    .description("Restart the persistent runner background service")
    .option("-d, --dir <path>", "Runner directory", DEFAULT_RUNNER_DIR)
    .action(async (options) => {
      logger.info("Restarting runner service...");
      await stopService(options.dir);
      const res = await startService(options.dir);
      if (res.success) {
        logger.success("Runner service restarted successfully.");
      } else {
        logger.error(res.message);
        process.exit(1);
      }
    });
}
