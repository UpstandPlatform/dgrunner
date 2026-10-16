import { Command } from "commander";
import pc from "picocolors";
import { password, confirm } from "@inquirer/prompts";
import { removeRunner, isRunnerConfigured, readMetadataForRunner, resolveRunnerDirectory } from "../core/runner-manager.js";
import { validateRegistrationToken } from "../core/security.js";
import { logger } from "../utils/logger.js";
import { DEFAULT_RUNNER_DIR } from "../config/constants.js";

export function registerRemoveCommand(program: Command): void {
  program
    .command("remove")
    .description("Unregister and remove the GitHub Actions runner from GitHub")
    .option("-t, --token <token>", "GitHub runner removal token")
    .option("-d, --dir <path>", "Runner directory", DEFAULT_RUNNER_DIR)
    .option("--runner <name>", "Configured runner name or Docker container name")
    .option("-y, --yes", "Skip interactive confirmation", false)
    .action(async (options) => {
      logger.header("Remove GitHub Actions Runner");

      const resolved = await resolveRunnerDirectory(options.runner, options.dir);
      if (resolved.error || !resolved.runnerDir) {
        logger.error(resolved.error || "Could not resolve the requested runner.");
        process.exitCode = 1;
        return;
      }

      const runnerDir = resolved.runnerDir;
      const metadata = await readMetadataForRunner(runnerDir);
      const configured = metadata?.mode === "docker" || isRunnerConfigured(runnerDir);
      if (!configured) {
        logger.warn(`No configured runner found in ${runnerDir}. Nothing to remove.`);
        return;
      }

      let token = options.token;

      if (!token) {
        console.log(pc.cyan("  Note: To remove a runner, GitHub requires a short-lived removal token."));
        console.log(pc.dim("  Get one from your repository/org Settings -> Actions -> Runners -> Click Runner -> Remove\n"));

        token = await password({
          message: "Enter runner removal token (hidden):",
          mask: "*",
          validate: (val) => {
            const res = validateRegistrationToken(val);
            return res.valid ? true : res.error || "Invalid token";
          },
        });
      }

      const tokenValidation = validateRegistrationToken(token);
      if (!tokenValidation.valid) {
        logger.error(`Invalid removal token: ${tokenValidation.error}`);
        process.exit(1);
      }

      if (!options.yes) {
        const proceed = await confirm({
          message: "Are you sure you want to unregister this runner and stop its service?",
          default: false,
        });

        if (!proceed) {
          logger.info("Runner removal cancelled.");
          return;
        }
      }

      logger.info("Unregistering runner and cleaning up service...");
      const res = await removeRunner(runnerDir, token);

      if (res.success) {
        logger.success("Runner successfully unregistered from GitHub and removed!");
        if (res.output) console.log(res.output);
      } else {
        logger.error("Failed to remove runner from GitHub.");
        console.error(res.output);
        process.exit(1);
      }
    });
}
