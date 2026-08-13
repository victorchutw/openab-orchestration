#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePaths = ["src", "scripts"].flatMap((directory) =>
  readdirSync(resolve(repositoryRoot, directory))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => resolve(repositoryRoot, directory, name)),
);

for (const path of sourcePaths.sort()) {
  execFileSync(process.execPath, ["--check", path], { stdio: "inherit" });
}
