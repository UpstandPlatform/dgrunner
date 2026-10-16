import { Command, Option } from "commander";
import pc from "picocolors";
import { runDoctorChecks } from "../core/doctor.js";
import { logger } from "../utils/logger.js";
import { DEFAULT_BASE_DIR } from "../config/constants.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run pre-flight security, dependency, and environment checks")
    .option("-d, --dir <path>", "Runner base directory to check", DEFAULT_BASE_DIR)
    .addOption(new Option("--env <environment>", "Target runner environment").choices(["windows", "docker", "wsl", "native"]))
    .option("--strict", "Fail with exit code 1 if any warnings or errors are found", false)
    .action(async (options) => {
      logger.header("dgrunner Pre-Flight & Security Doctor");

      const report = await runDoctorChecks({ targetDir: options.dir, targetEnv: options.env });

      for (const check of report.checks) {
        if (check.status === "pass") {
          console.log(`  ${pc.green("✔")} ${pc.bold(check.name)}: ${check.message}`);
        } else if (check.status === "warn") {
          console.log(`  ${pc.yellow("⚠")} ${pc.bold(check.name)}: ${pc.yellow(check.message)}`);
          if (check.detail) console.log(`     ${pc.dim(check.detail)}`);
          if (check.remediation) console.log(`     ${pc.cyan("Fix:")} ${check.remediation}`);
        } else {
          console.log(`  ${pc.red("✖")} ${pc.bold(check.name)}: ${pc.red(check.message)}`);
          if (check.detail) console.log(`     ${pc.dim(check.detail)}`);
          if (check.remediation) console.log(`     ${pc.cyan("Fix:")} ${check.remediation}`);
        }
      }

      console.log();

      if (report.ok && !report.hasWarnings) {
        logger.success("All pre-flight security and system checks passed! Ready for setup.");
      } else if (report.ok && report.hasWarnings) {
        logger.warn("Pre-flight checks passed with warnings. Review the recommendations above.");
        if (options.strict) {
          process.exit(1);
        }
      } else {
        logger.error("Critical pre-flight checks failed. Please fix the issues before setting up the runner.");
        process.exit(1);
      }
    });
}
