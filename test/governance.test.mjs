import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

test("repository governance records the accepted licensing boundary", () => {
  const license = read("LICENSE");
  assert.equal(license.match(/Permission is hereby granted/g)?.length, 1);
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 Victor Chu\n/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);

  const scope = read("LICENSE_SCOPE.md");
  for (const path of [
    "docs/research/openab-upstream-orchestration.md",
    "docs/research/openab-independent-review-sessions.md",
    "docs/research/graph-engineering.md",
    "docs/research/runtime-ssot-alternatives.md",
    "docs/research/runtime-ssot-alternatives.html",
  ]) {
    assert.match(scope, new RegExp(path.replaceAll(".", "\\.")));
  }
  assert.match(scope, /outside\s+the project's MIT grant/i);
  assert.match(scope, /Contributor\s+Covenant 2\.1.*CC BY 4\.0/is);
});

test("contribution, conduct, and security terms preserve human accountability", () => {
  const dco = read("DCO.md");
  assert.match(dco, /Developer's Certificate of Origin 1\.1/);
  assert.match(dco, /changing it is not allowed/);
  assert.match(dco, /\(a\).*\(b\).*\(c\).*\(d\)/s);

  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, /Signed-off-by:/);
  assert.match(contributing, /no Contributor License Agreement/i);
  assert.match(contributing, /material agent or AI generation/i);
  assert.match(contributing, /responsible natural person/i);
  assert.match(contributing, /bounded implementation\s+loop/i);
  assert.match(contributing, /independent review/i);
  assert.match(contributing, /staged tree/i);
  assert.match(contributing, /reachable history/i);
  assert.match(contributing, /human exposure review/i);

  const agentInstructions = read("AGENTS.md");
  assert.match(agentInstructions, /docs\/agents\/implementation-loop\.md/);

  const implementationLoop = read("docs/agents/implementation-loop.md");
  assert.match(implementationLoop, /maintainer-triggered/i);
  assert.match(implementationLoop, /assignee is\s+the current implementer/i);
  assert.match(implementationLoop, /one independent reviewer/i);
  assert.match(implementationLoop, /at most one in-scope review-fix pass/i);
  assert.match(implementationLoop, /evidence is durably linked from the ticket/i);
  assert.match(implementationLoop, /reconcile an uncertain write/i);
  assert.match(implementationLoop, /DCO\s+certification/i);
  assert.match(implementationLoop, /npm run check:public/i);
  assert.match(implementationLoop, /current ticket is merged/i);
  assert.match(implementationLoop, /required CI check has completed successfully/i);
  assert.match(implementationLoop, /recommend exactly one next ticket/i);

  const conduct = read("CODE_OF_CONDUCT.md");
  assert.match(conduct, /Contributor Covenant.*version 2\.1/is);
  assert.match(conduct, /Creative Commons Attribution 4\.0/i);
  assert.doesNotMatch(conduct, /INSERT CONTACT METHOD/);

  const security = read("SECURITY.md");
  assert.match(security, /report.*privately/is);
  assert.match(security, /do not.*public issue/is);
  assert.match(security, /credentials.*Evidence Bundles/is);
});
