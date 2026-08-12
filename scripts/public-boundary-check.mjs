#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const FORBIDDEN_PATHS = [
  {
    pattern:
      /^(?:runtime|evidence|worktrees|target-repositories|logs)(?:\/|$)/i,
    reason: "private runtime, evidence, workspace, or log path",
  },
  {
    pattern: /(?:^|\/)\.env(?:\.|$)/i,
    reason: "private environment configuration path",
  },
  {
    pattern: /(?:^|\/)(?:\.kube|\.ssh|\.aws)(?:\/|$)/i,
    reason: "credential or deployment-binding path",
  },
  {
    pattern: /\.(?:db|sqlite|sqlite3|pem|key|p12|pfx|jks|kdbx)$/i,
    reason: "private runtime database or credential file type",
  },
];

const SENSITIVE_CONTENT = [
  {
    pattern: /gh[pousr]_[A-Za-z0-9]{30,}/g,
    reason: "possible GitHub token",
  },
  {
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    reason: "possible private key",
  },
  {
    pattern: /AKIA[0-9A-Z]{16}/g,
    reason: "possible AWS access key",
  },
];

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--repository-root") {
    throw new Error(
      "Usage: public-boundary-check --repository-root <checkout>",
    );
  }
  return resolve(args[1]);
}

function git(repositoryRoot, args, encoding) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function splitNullTerminated(value) {
  return value.split("\0").filter(Boolean);
}

function inspectPath(path, source, findings) {
  for (const rule of FORBIDDEN_PATHS) {
    if (rule.pattern.test(path)) {
      findings.push(`${source}: ${path}: ${rule.reason}`);
    }
  }
}

function inspectContent(content, path, source, findings) {
  if (content.includes(0)) {
    return;
  }
  const text = content.toString("utf8");
  for (const rule of SENSITIVE_CONTENT) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      findings.push(`${source}: ${path}: ${rule.reason}`);
    }
  }
}

function inspectStagedTree(repositoryRoot, findings) {
  const paths = splitNullTerminated(
    git(
      repositoryRoot,
      ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
      "utf8",
    ),
  );
  for (const path of paths) {
    inspectPath(path, "staged tree", findings);
    const content = git(repositoryRoot, ["show", `:${path}`]);
    inspectContent(content, path, "staged tree", findings);
  }
  return paths.length;
}

function inspectReachableHistory(repositoryRoot, findings) {
  const objects = git(repositoryRoot, ["rev-list", "--objects", "--all"], "utf8")
    .split("\n")
    .filter(Boolean);
  const inspected = new Set();
  let blobCount = 0;
  for (const object of objects) {
    const separator = object.indexOf(" ");
    if (separator === -1) {
      continue;
    }
    const oid = object.slice(0, separator);
    const path = object.slice(separator + 1);
    const identity = `${oid}\0${path}`;
    if (inspected.has(identity)) {
      continue;
    }
    inspected.add(identity);
    if (git(repositoryRoot, ["cat-file", "-t", oid], "utf8").trim() !== "blob") {
      continue;
    }
    blobCount += 1;
    inspectPath(path, "reachable history", findings);
    inspectContent(
      git(repositoryRoot, ["cat-file", "blob", oid]),
      path,
      "reachable history",
      findings,
    );
  }
  return blobCount;
}

function main(args) {
  const repositoryRoot = parseArguments(args);
  git(repositoryRoot, ["rev-parse", "--is-inside-work-tree"], "utf8");
  const findings = [];
  const stagedCount = inspectStagedTree(repositoryRoot, findings);
  const historyCount = inspectReachableHistory(repositoryRoot, findings);

  if (findings.length > 0) {
    process.stderr.write(
      `Public-boundary check failed:\n${findings
        .map((finding) => `- ${finding}`)
        .join("\n")}\n`,
    );
    return 1;
  }

  process.stdout.write(
    "Public-boundary automated checks passed for " +
      `the staged tree (${stagedCount} paths) and ` +
      `reachable history (${historyCount} blobs). ` +
      "Human exposure review is still required before public push; " +
      "automated checks and ignore rules are defense in depth.\n",
  );
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `Public-boundary check could not complete: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 2;
}
