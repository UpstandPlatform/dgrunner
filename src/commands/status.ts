import { Command } from "commander";
import pc from "picocolors";
import { getRunnerStatus } from "../core/runner-manager.js";
import { logger } from "../utils/logger.js";
import { DEFAULT_RUNNER_DIR } from "../config/constants.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Check status of the installed runner and background service")
    .option("-d, --dir <path>", "Runner directory to check", DEFAULT_RUNNER_DIR)
    .action(async (options) => {
      logger.header("dgrunner Status Dashboard");

      const status = await getRunnerStatus(options.dir);

      const statusLines: string[] = [
        `Installed:   ${status.installed ? pc.green("Yes") : pc.red("No")}`,
        `Configured:  ${status.configured ? pc.green("Yes") : pc.yellow("No")}`,
      ];

      if (status.runnerName) {
        statusLines.push(`Runner Name: ${pc.bold(status.runnerName)}`);
      }

      if (status.targetUrl) {
        statusLines.push(`Target URL:  ${pc.cyan(status.targetUrl)}`);
      }

      if (status.labels && status.labels.length > 0) {
        statusLines.push(`Labels:      ${status.labels.join(", ")}`);
      }

      const serviceStatus = status.serviceRunning
        ? pc.green(`Active & Running${status.activePid ? ` (PID: ${status.activePid})` : ""}`)
        : status.serviceInstalled
        ? pc.yellow("Installed, but Stopped")
        : pc.dim("Not configured");

      statusLines.push(`Service:     ${serviceStatus}`);
      statusLines.push(`Directory:   ${options.dir}`);

      const borderColor = status.serviceRunning ? "green" : status.configured ? "yellow" : "red";
      logger.box("RUNNER STATUS", statusLines, borderColor);

      if (!status.installed) {
        console.log(`  To install, run: ${pc.green("dgrunner setup")}`);
      } else if (!status.serviceRunning) {
        console.log(`  To start the runner, run: ${pc.green("dgrunner start")}`);
      }
      console.log();
    });
}
