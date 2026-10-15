import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(projectRoot, "skills");
const configPath = path.join(projectRoot, "skills.sh.json");

function fail(message) {
  console.error(`Agent skill validation failed: ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(skillsRoot)) {
  fail("skills/ directory is missing.");
  process.exit();
}

const skillDirs = fs.readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (skillDirs.length === 0) {
  fail("no skill directories were found under skills/.");
}

const discoveredNames = new Set();
for (const skillDir of skillDirs) {
  const skillPath = path.join(skillsRoot, skillDir, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    fail(`${skillDir}/SKILL.md is missing.`);
    continue;
  }

  const content = fs.readFileSync(skillPath, "utf8");
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) {
    fail(`${skillDir}/SKILL.md must start with YAML frontmatter.`);
    continue;
  }

  const name = frontmatter[1].match(/^name:\s*([^\r\n]+)\s*$/m)?.[1]?.trim();
  const description = frontmatter[1].match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim();
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    fail(`${skillDir}/SKILL.md needs a lowercase, hyphenated name field.`);
  }
  if (name && name !== skillDir) {
    fail(`${skillDir}/SKILL.md name must match its directory (${name}).`);
  }
  if (!description) {
    fail(`${skillDir}/SKILL.md needs a non-empty description field.`);
  }
  if (name && discoveredNames.has(name)) {
    fail(`duplicate skill name ${name}.`);
  }
  if (name) discoveredNames.add(name);
}

try {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!Array.isArray(config.groupings) || config.groupings.length === 0) {
    fail("skills.sh.json must define at least one grouping.");
  } else {
    for (const grouping of config.groupings) {
      if (typeof grouping.title !== "string" || grouping.title.trim() === "") {
        fail("every skills.sh.json grouping must have a title.");
      }
      if (!Array.isArray(grouping.skills) || grouping.skills.length === 0) {
        fail(`grouping '${grouping.title || "(unnamed)"}' must include at least one skill.`);
        continue;
      }
      for (const name of grouping.skills) {
        if (!discoveredNames.has(name)) {
          fail(`skills.sh.json references unknown skill '${name}'.`);
        }
      }
    }
  }
} catch (error) {
  fail(`skills.sh.json is not valid JSON (${error.message}).`);
}

if (process.exitCode !== 1) {
  console.log(`Validated ${discoveredNames.size} skills and skills.sh.json.`);
}
