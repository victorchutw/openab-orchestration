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
const entryPath = resolve(repositoryRoot, "src/openab-orchestration.mjs");
const packageMetadata = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
);
const localModuleEdge =
  /^(import|export)\s*\{([^}]*)\}\s*from\s*"(\.\/[^"\n]+\.mjs)";\r?\n?/gm;

function moduleGraph(rootPath) {
  const visited = new Set();
  const ordered = [];
  const publicReexports = new Set();

  function visit(path) {
    if (visited.has(path)) {
      return;
    }
    visited.add(path);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(localModuleEdge)) {
      visit(resolve(dirname(path), match[3]));
      if (path === rootPath && match[1] === "export") {
        for (const name of match[2].split(",")) {
          publicReexports.add(name.trim());
        }
      }
    }
    ordered.push({ path, source });
  }

  visit(rootPath);
  return { ordered, publicReexports: [...publicReexports] };
}

function bundle(rootPath) {
  const graph = moduleGraph(rootPath);
  const bodies = graph.ordered.map(({ path, source }) => {
    const withoutShebang = source.replace(/^#![^\n]*\n/, "");
    const withoutLocalEdges = withoutShebang.replace(localModuleEdge, "");
    return path === rootPath
      ? withoutLocalEdges
      : withoutLocalEdges.replace(/^export /gm, "");
  });
  const reexports =
    graph.publicReexports.length === 0
      ? ""
      : `\nexport { ${graph.publicReexports.join(", ")} };\n`;
  return `#!/usr/bin/env node\n\n${bodies.join("\n")}${reexports}`;
}

const entrySource = readFileSync(entryPath, "utf8");
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
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(artifact, bundle(entryPath), { mode: 0o755 });
chmodSync(artifact, 0o755);

process.stdout.write(`${artifact}\n`);
