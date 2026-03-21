import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const marketplacePath = path.join(
  repoRoot,
  ".claude-plugin",
  "marketplace.json",
);
const pluginManifestPath = path.join(
  repoRoot,
  "plugins",
  "mgrep",
  ".claude-plugin",
  "plugin.json",
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJsonIfChanged(filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : undefined;

  if (existing !== serialized) {
    fs.writeFileSync(filePath, serialized);
  }
}

const packageJson = readJson(packageJsonPath);
if (
  typeof packageJson.version !== "string" ||
  packageJson.version.length === 0
) {
  throw new Error("package.json version is missing or invalid");
}

const version = packageJson.version;

const marketplace = readJson(marketplacePath);
if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
  throw new Error(".claude-plugin/marketplace.json does not contain plugins");
}
marketplace.plugins[0].version = version;
writeJsonIfChanged(marketplacePath, marketplace);

const pluginManifest = readJson(pluginManifestPath);
pluginManifest.version = version;
writeJsonIfChanged(pluginManifestPath, pluginManifest);
