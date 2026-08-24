import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = resolve(repositoryRoot, "scripts/check-dco.mjs");

function git(repository, ...args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "openab-dco-"));
  git(repository, "init", "--quiet");
  git(repository, "config", "user.name", "DCO Test");
  git(repository, "config", "user.email", "dco@example.invalid");
  writeFileSync(join(repository, "fixture.txt"), "base\n");
  git(repository, "add", "fixture.txt");
  git(repository, "commit", "--quiet", "-m", "unsigned base");
  return repository;
}

function inspect(repository, base, head) {
  return spawnSync(process.execPath, [checker, base, head], {
    cwd: repository,
    encoding: "utf8",
  });
}

function addCommit(repository, message, signoff = false) {
  writeFileSync(join(repository, "fixture.txt"), `${message}\n`, {
    flag: "a",
  });
  git(repository, "add", "fixture.txt");
  const args = ["commit", "--quiet", "-m", message];
  if (signoff) {
    args.push("--signoff");
  }
  git(repository, ...args);
  return git(repository, "rev-parse", "HEAD");
}

test("DCO check accepts each introduced commit signed by its author", () => {
  const repository = createRepository();
  try {
    const base = git(repository, "rev-parse", "HEAD");
    addCommit(repository, "first signed commit", true);
    const head = addCommit(repository, "second signed commit", true);

    const result = inspect(repository, base, head);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed for 2 commit\(s\)/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("DCO check rejects an unsigned introduced commit", () => {
  const repository = createRepository();
  try {
    const base = git(repository, "rev-parse", "HEAD");
    const head = addCommit(repository, "unsigned change");

    const result = inspect(repository, base, head);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing Signed-off-by: DCO Test/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("DCO check rejects a sign-off that does not match the author", () => {
  const repository = createRepository();
  try {
    const base = git(repository, "rev-parse", "HEAD");
    const head = addCommit(
      repository,
      "mismatched sign-off\n\nSigned-off-by: Someone Else <else@example.invalid>",
    );

    const result = inspect(repository, base, head);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing Signed-off-by: DCO Test/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
