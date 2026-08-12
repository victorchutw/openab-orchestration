import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = resolve(repositoryRoot, "scripts/public-boundary-check.mjs");

function git(repository, ...args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "openab-exposure-"));
  git(repository, "init", "--quiet");
  git(repository, "config", "user.name", "Exposure Test");
  git(repository, "config", "user.email", "exposure@example.invalid");
  writeFileSync(join(repository, "README.md"), "Synthetic public content.\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "--quiet", "-m", "public baseline");
  return repository;
}

function inspect(repository) {
  return spawnSync(
    process.execPath,
    [checker, "--repository-root", repository],
    { encoding: "utf8" },
  );
}

test("public-boundary check scans staged content and requires human review", () => {
  const repository = createRepository();
  try {
    const clean = inspect(repository);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /staged tree/i);
    assert.match(clean.stdout, /reachable history/i);
    assert.match(clean.stdout, /human exposure review is still required/i);

    mkdirSync(join(repository, "runtime"));
    writeFileSync(
      join(repository, "runtime/installation.json"),
      `${JSON.stringify({
        token: `ghp_${"0123456789abcdefghijklmnopqrstuvwxyz"}`,
      })}\n`,
    );
    git(repository, "add", "runtime/installation.json");

    const stagedLeak = inspect(repository);
    assert.equal(stagedLeak.status, 1);
    assert.match(stagedLeak.stderr, /runtime\/installation\.json/);
    assert.match(stagedLeak.stderr, /possible GitHub token/i);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("public-boundary check scans secrets in reachable history", () => {
  const repository = createRepository();
  try {
    writeFileSync(
      join(repository, "removed-secret.txt"),
      `${"-----BEGIN"} PRIVATE KEY-----\nsynthetic-test-only\n`,
    );
    git(repository, "add", "removed-secret.txt");
    git(repository, "commit", "--quiet", "-m", "add historical fixture");
    rmSync(join(repository, "removed-secret.txt"));
    git(repository, "add", "removed-secret.txt");
    git(repository, "commit", "--quiet", "-m", "remove historical fixture");

    const historyLeak = inspect(repository);
    assert.equal(historyLeak.status, 1);
    assert.match(historyLeak.stderr, /reachable history/i);
    assert.match(historyLeak.stderr, /possible private key/i);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
