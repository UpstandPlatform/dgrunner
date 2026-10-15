import { Command } from "commander";
import pc from "picocolors";
import { printGitHubSetupGuide, writeVerificationWorkflow } from "../core/guide.js";
import { logger } from "../utils/logger.js";

export function registerGuideCommand(program: Command): void {
  program
    .command("guide")
    .description("View step-by-step GitHub runner installation and integration guides")
    .option("-s, --scope <scope>", "Scope to display guide for ('repo' or 'org')")
    .option("-w, --generate-workflow", "Generate .github/workflows/verify-runner.yml in current project")
    .action(async (options) => {
      const scope = options.scope === "org" || options.scope === "repo" ? options.scope : undefined;
      printGitHubSetupGuide(scope);

      if (options.generateWorkflow) {
        try {
          const filePath = await writeVerificationWorkflow(process.cwd());
          logger.success(`Verification workflow generated at: ${pc.bold(filePath)}`);
          console.log();
          console.log("  To test your runner, push this workflow to your repository:");
          console.log(pc.cyan("    git add .github/workflows/verify-runner.yml"));
          console.log(pc.cyan('    git commit -m "ci: add dgrunner verification workflow"'));
          console.log(pc.cyan("    git push"));
          console.log();
        } catch (err: any) {
          logger.error(`Failed to generate workflow file: ${err.message}`);
        }
      }
    });
}
