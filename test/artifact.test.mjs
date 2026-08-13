import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
);
const artifact = resolve(repositoryRoot, `dist/openab-orchestration-v${version}.mjs`);

test("a clean checkout builds one executable versioned product artifact", async () => {
  execFileSync(process.execPath, ["scripts/build.mjs"], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });

  assert.notEqual(statSync(artifact).mode & 0o111, 0);
  assert.deepEqual(
    JSON.parse(execFileSync(artifact, ["version"], { encoding: "utf8" })),
    {
      name: "openab-orchestration",
      version,
    },
  );
  assert.deepEqual(
    JSON.parse(
      execFileSync(artifact, ["modes"], { encoding: "utf8" }),
    ).processModes.map(({ id }) => id),
    [
      "runtime-core",
      "execution-worker",
      "github-publisher",
      "discord-operator-interface",
    ],
  );
  const productModule = await import(
    `${pathToFileURL(artifact).href}?test=${Date.now()}`
  );
  assert.equal(typeof productModule.openRuntimeCore, "function");
});
