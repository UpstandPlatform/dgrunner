import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const builtCliVersion = execFileSync(
  process.execPath,
  [path.join(projectRoot, "dist", "index.js"), "--version"],
  { encoding: "utf8" }
).trim();

if (builtCliVersion !== packageJson.version) {
  console.error(`Built CLI version ${builtCliVersion} does not match package.json version ${packageJson.version}.`);
  process.exitCode = 1;
} else {
  console.log(`Verified CLI and package version ${packageJson.version}.`);
}
