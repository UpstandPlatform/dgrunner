import { Command } from "commander";
import { APP_DESCRIPTION, APP_NAME, APP_VERSION } from "./config/constants.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerSetupCommand, runSetupFlow } from "./commands/setup.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerServiceCommands } from "./commands/service.js";
import { registerRemoveCommand } from "./commands/remove.js";
import { registerGuideCommand } from "./commands/guide.js";
import { registerUpgradeCommand } from "./commands/upgrade.js";

const program = new Command();

program
  .name(APP_NAME)
  .version(APP_VERSION)
  .description(APP_DESCRIPTION)
  .helpOption("-h, --help", "Display help for command");

// Register Subcommands
registerDoctorCommand(program);
registerSetupCommand(program);
registerStatusCommand(program);
registerServiceCommands(program);
registerRemoveCommand(program);
registerGuideCommand(program);
registerUpgradeCommand(program);

// If called with no arguments, launch interactive setup wizard
if (process.argv.length <= 2) {
  runSetupFlow().catch((err) => {
    if (err.name === "ExitPromptError") {
      console.log("\nSetup cancelled by user.");
      process.exit(0);
    }
    console.error("\nUnexpected error:", err);
    process.exit(1);
  });
} else {
  program.parseAsync(process.argv).catch((err) => {
    if (err.name === "ExitPromptError") {
      console.log("\nOperation cancelled by user.");
      process.exit(0);
    }
    console.error("Error:", err.message || err);
    process.exit(1);
  });
}
