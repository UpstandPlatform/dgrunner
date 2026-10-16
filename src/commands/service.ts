import { Command } from "commander";
import pc from "picocolors";
import {
  startService,
  stopService,
  restartService,
  runForeground,
  listRunnerProcesses,
  tailRunnerLogs,
  resolveRunnerDirectory,
} from "../core/runner-manager.js";
import { logger } from "../utils/logger.js";
import { DEFAULT_RUNNER_DIR } from "../config/constants.js";

async function selectedRunnerDir(options: { runner?: string; dir: string }): Promise<string | undefined> {
  const resolved = await resolveRunnerDirectory(options.runner, options.dir);
  if (resolved.error || !resolved.runnerDir) {
    logger.error(resolved.error || "Could not resolve the requested runner.");
    process.exitCode = 1;
    return undefined;
  }
  return resolved.runnerDir;
}

export function registerServiceCommands(program: Command): void {
  // dgrunner start [--attach]
  program
    .command("start")
    .description("Start the persistent runner background service or run attached")
    .option("-d, --dir <path>", "Runner directory", DEFAULT_RUNNER_DIR)
    .option("--runner <name>", "Configured runner name or Docker container name")
    .option("-a, --attach", "Run in foreground and stay attached listening for jobs", false)
    .action(async (options) => {
      const runnerDir = await selectedRunnerDir(options);
      if (!runnerDir) return;
      if (options.attach) {
        logger.info("Starting runner in foreground attached mode (Press Ctrl+C to stop)...");
        const exitCode = await runForeground(runnerDir);
        process.exit(exitCode);
      } else {
        const runnerSelector = options.runner ? ` --runner ${options.runner}` : "";
        logger.info("Starting runner in the background...");
        const res = await startService(runnerDir);
        if (res.success) {
          logger.success(res.message);
          console.log(pc.dim("  Tip: View live logs with: ") + pc.cyan(`dgrunner logs${runnerSelector} --follow`));
          console.log(pc.dim("  Tip: Or run attached with: ") + pc.cyan(`dgrunner run${runnerSelector}`));
        } else {
          logger.error(res.message);
          process.exit(1);
        }
      }
    });

  // dgrunner run (attached shortcut)
  program
    .command("run")
    .description("Start the runner attached in foreground and stream live job logs")
    .option("-d, --dir <path>", "Runner directory", DEFAULT_RUNNER_DIR)
    .option("--runner <name>", "Configured runner name or Docker container name")
    .action(async (options) => {
      const runnerDir = await selectedRunnerDir(options);
      if (!runnerDir) return;
      logger.info("Starting runner in foreground attached mode (Press Ctrl+C to stop)...");
      const exitCode = await runForeground(runnerDir);
      process.exit(exitCode);
    });

  // dgrunner stop
  program
    .command("stop")
    .description("Stop the runner service or foreground process")
    .option("-d, --dir <path>", "Runner directory", DEFAULT_RUNNER_DIR)
    .option("--runner <name>", "Configured runner name or Docker container name")
    .action(async (options) => {
      const runnerDir = await selectedRunnerDir(options);
      if (!runnerDir) return;
      logger.info("Stopping runner...");
      const res = await stopService(runnerDir);
      if (res.success) {
        logger.success(res.message);
      } else {
        logger.error(res.message);
        process.exit(1);
      }
    });

  // dgrunner restart
  program
    .command("restart")
    .description("Restart the persistent runner background service")
    .option("-d, --dir <path>", "Runner directory", DEFAULT_RUNNER_DIR)
    .option("--runner <name>", "Configured runner name or Docker container name")
    .action(async (options) => {
      const runnerDir = await selectedRunnerDir(options);
      if (!runnerDir) return;
      logger.info("Restarting runner service...");
      const res = await restartService(runnerDir);
      if (res.success) {
        logger.success(res.message);
      } else {
        logger.error(res.message);
        process.exit(1);
      }
    });

  // dgrunner ps (list running processes)
  program
    .command("ps")
    .alias("list")
    .description("List active runner processes managed by dgrunner")
    .option("-d, --dir <path>", "Runner directory", DEFAULT_RUNNER_DIR)
    .action(async (options) => {
      logger.header("Active dgrunner Processes");
      const procs = await listRunnerProcesses(options.dir);

      if (procs.length === 0) {
        console.log(pc.yellow("  No active runner processes currently running."));
        console.log(pc.dim("  Start one with: ") + pc.cyan("dgrunner start") + pc.dim(" or ") + pc.cyan("dgrunner run\n"));
        return;
      }

      console.log(
        pc.bold(
          `${"PID".padEnd(8)} ${"PROCESS".padEnd(18)} ${"RUNNER NAME".padEnd(20)} ${"MEMORY".padEnd(10)} ${"STATUS".padEnd(12)} TARGET`
        )
      );
      console.log(pc.dim("─".repeat(85)));

      for (const p of procs) {
        const pidStr = String(p.pid).padEnd(8);
        const nameStr = p.name.padEnd(18);
        const runnerStr = (p.runnerName || "dgrunner").padEnd(20);
        const hasMemory = typeof p.memoryMb === "number" && Number.isFinite(p.memoryMb);
        const memStr = (hasMemory ? `${p.memoryMb} MB` : "N/A").padEnd(10);
        const statusStr = pc.green(p.status.padEnd(12));
        const urlStr = pc.cyan(p.targetUrl || "N/A");
        console.log(`${pidStr} ${nameStr} ${runnerStr} ${memStr} ${statusStr} ${urlStr}`);
      }
      console.log();
    });

  // dgrunner logs [--follow] [--lines <n>] [--dir <path>]
  program
    .command("logs")
    .alias("attach")
    .description("View or follow real-time logs of the background runner")
    .option("-f, --follow", "Follow live log output continuously", false)
    .option("-n, --lines <count>", "Number of initial lines to display", "50")
    .option("-d, --dir <path>", "Runner installation directory", DEFAULT_RUNNER_DIR)
    .option("--runner <name>", "Configured runner name or Docker container name")
    .action(async (options) => {
      const runnerDir = await selectedRunnerDir(options);
      if (!runnerDir) return;
      logger.header("dgrunner Background Service Logs");
      await tailRunnerLogs({
        follow: options.follow,
        lines: parseInt(options.lines, 10) || 50,
        runnerDir,
      });
    });
}
