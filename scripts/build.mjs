#!/usr/bin/env node

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
);
const entrySource = readFileSync(
  resolve(repositoryRoot, "src/openab-orchestration.mjs"),
  "utf8",
);
const internalModuleSource = ["core-model.mjs", "durability.mjs"]
  .map((name) =>
    readFileSync(resolve(repositoryRoot, "src", name), "utf8").replace(
      /^export /gm,
      "",
    ),
  )
  .join("\n");
const runtimeCoreSource = readFileSync(
  resolve(repositoryRoot, "src/runtime-core.mjs"),
  "utf8",
).replace(/^import .* from "\.\/(?:core-model|durability)\.mjs";\n/gm, "");
const declaredVersion = entrySource.match(/version: "([^"]+)"/)?.[1];

if (declaredVersion !== packageMetadata.version) {
  throw new Error(
    `Product version ${
      declaredVersion ?? "<missing>"
    } does not match package version ${packageMetadata.version}`,
  );
}

const outputDirectory = resolve(repositoryRoot, "dist");
const artifact = resolve(
  outputDirectory,
  `openab-orchestration-v${packageMetadata.version}.mjs`,
);
const source = `#!/usr/bin/env node

${internalModuleSource}
${runtimeCoreSource}
${entrySource
  .replace(/^#![^\n]*\n/, "")
  .replace('export { openRuntimeCore } from "./runtime-core.mjs";\n', "")}`;
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(artifact, source, { mode: 0o755 });
chmodSync(artifact, 0o755);

process.stdout.write(`${artifact}\n`);
