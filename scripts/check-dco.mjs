#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";

const FULL_SHA = /^[0-9a-f]{40}$/;

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function validateRevision(value, label) {
  if (!FULL_SHA.test(value)) {
    throw new Error(`${label} must be a full lowercase Git commit SHA`);
  }
  git(["rev-parse", "--verify", `${value}^{commit}`]);
}

function signoffs(message) {
  const result = spawnSync("git", ["interpret-trailers", "--parse"], {
    encoding: "utf8",
    input: message,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "git interpret-trailers failed");
  }
  return result.stdout
    .split("\n")
    .map((line) => line.match(/^Signed-off-by:\s*(.+)$/i)?.[1])
    .filter(Boolean);
}

function inspectCommit(commit) {
  const fields = git([
    "show",
    "--quiet",
    "--format=%an%x00%ae%x00%B%x00",
    commit,
  ]).split("\0");
  const expected = `${fields[0]} <${fields[1]}>`;
  const trailers = signoffs(fields[2]);
  return {
    commit,
    expected,
    valid: trailers.some(
      (trailer) => trailer.toLowerCase() === expected.toLowerCase(),
    ),
  };
}

export function checkDco(base, head) {
  validateRevision(base, "base");
  validateRevision(head, "head");
  const commits = git(["rev-list", "--reverse", `${base}..${head}`])
    .trim()
    .split("\n")
    .filter(Boolean);
  if (commits.length === 0) {
    throw new Error(`No commits found in ${base}..${head}`);
  }
  return commits.map(inspectCommit);
}

function main(args) {
  if (args.length !== 2) {
    throw new Error("Usage: check-dco <base-commit> <head-commit>");
  }
  const results = checkDco(args[0], args[1]);
  const invalid = results.filter(({ valid }) => !valid);
  if (invalid.length > 0) {
    process.stderr.write(
      "DCO check failed:\n" +
        invalid
          .map(
            ({ commit, expected }) =>
              `- ${commit}: missing Signed-off-by: ${expected}`,
          )
          .join("\n") +
        "\n",
    );
    return 1;
  }
  process.stdout.write(
    `DCO check passed for ${results.length} commit(s).\n`,
  );
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `DCO check could not complete: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 2;
}
