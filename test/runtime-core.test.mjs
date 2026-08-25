import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { openRuntimeCore } from "../src/runtime-core.mjs";
import { canonicalDigest } from "../src/canonical.mjs";
import { openDurability } from "../src/durability.mjs";

const OPERATOR_ID = "operator:test";
const ORCHESTRATOR_ID = "agent-role:orchestrator";
const CONFIGURATION_DIGEST = `sha256:${"a".repeat(64)}`;
const PLANNING_PROFILE = Object.freeze({
  id: "profile:orchestrator-scripted-1",
  servingProvider: "scripted",
  model: "scripted-plan-v1",
  runtime: "in-memory",
});

function runtimeCoreOptions(primaryRoot, recoveryRoot) {
  let operatorOfferSequence = 0;
  return {
    primaryRoot,
    recoveryRoot,
    operatorIdentity: OPERATOR_ID,
    orchestratorIdentity: ORCHESTRATOR_ID,
    planningExecutionProfile: PLANNING_PROFILE,
    configurationRevision: "configuration:test-1",
    effectiveConfigurationDigest: CONFIGURATION_DIGEST,
    secretReferenceGenerations: {
      "execution-worker/provider-authentication": "generation:test-provider-1",
    },
    clock: () => "2026-08-13T00:00:00.000Z",
    identifiers: {
      offer: () => "offer:test-1",
      restoreOffer: () => "offer:restore-1",
      postRestoreOffer: () => "offer:post-restore-1",
      run: () => "run:test-1",
      commit: () => "commit:test-1",
      effectIntent: () => "effect-intent:test-1",
      execution: () => "execution:planning-test-1",
      directive: () => "directive:planning-test-1",
      operatorOffer: () =>
        `offer:planning-action-${(operatorOfferSequence += 1)}`,
    },
  };
}

function withRuntimeCore(testBody) {
  const root = mkdtempSync(join(tmpdir(), "openab-runtime-core-"));
  const primaryRoot = join(root, "primary");
  const recoveryRoot = join(root, "recovery");
  mkdirSync(primaryRoot);
  mkdirSync(recoveryRoot);
  const options = runtimeCoreOptions(primaryRoot, recoveryRoot);
  let core = openRuntimeCore(options);

  return Promise.resolve(
    testBody({
      core,
      primaryRoot,
      recoveryRoot,
      reopen() {
        core.close();
        core = openRuntimeCore(options);
        return core;
      },
    }),
  ).finally(() => {
      core.close();
      rmSync(root, { recursive: true, force: true });
  });
}

function withPlanningRuntimeCore(testBody, { clock } = {}) {
  const root = mkdtempSync(join(tmpdir(), "openab-planning-runtime-core-"));
  const primaryRoot = join(root, "primary");
  const recoveryRoot = join(root, "recovery");
  mkdirSync(primaryRoot);
  mkdirSync(recoveryRoot);
  let commitSequence = 0;
  let effectSequence = 0;
  let executionSequence = 0;
  let directiveSequence = 0;
  let operatorOfferSequence = 0;
  const baseOptions = runtimeCoreOptions(primaryRoot, recoveryRoot);
  const options = {
    ...baseOptions,
    clock: clock ?? baseOptions.clock,
    identifiers: {
      ...baseOptions.identifiers,
      commit: () => `commit:test-${(commitSequence += 1)}`,
      effectIntent: () => `effect-intent:test-${(effectSequence += 1)}`,
      execution: () => `execution:planning-test-${(executionSequence += 1)}`,
      directive: () => `directive:planning-test-${(directiveSequence += 1)}`,
      operatorOffer: () =>
        `offer:planning-action-${(operatorOfferSequence += 1)}`,
    },
  };
  let core = openRuntimeCore(options);

  return Promise.resolve(
    testBody({
      core,
      options,
      primaryRoot,
      close() {
        core.close();
        core = undefined;
      },
      reopen() {
        core.close();
        core = openRuntimeCore(options);
        return core;
      },
    }),
  ).finally(() => {
    core?.close();
    rmSync(root, { recursive: true, force: true });
  });
}

function validPlanningResult({
  executionId = "execution:planning-test-1",
  planRevision = 1,
  objective = "Prepare an execution-ready plan",
} = {}) {
  return {
    format: "openab.planning-execution-result/v1",
    executionId,
    planRevision,
    agentRoleIdentity: ORCHESTRATOR_ID,
    executionProfileId: PLANNING_PROFILE.id,
    outcome: "Succeeded",
    runPlan: {
      objective,
      scope: ["Runtime Core planning lifecycle"],
      acceptanceBoundary: ["The Operator confirms a durable plan"],
      evidenceRequirements: ["Runtime Core behavioral tests pass"],
      remediationAllowance: { maximumRounds: 1 },
      eligibleExecutionProfiles: {
        coding: ["profile:coding-primary", "profile:coding-fallback"],
        reviewerA: ["profile:reviewer-a-primary"],
        reviewerB: ["profile:reviewer-b-primary"],
      },
      fallbackOrder: {
        coding: ["profile:coding-primary", "profile:coding-fallback"],
        reviewerA: ["profile:reviewer-a-primary"],
        reviewerB: ["profile:reviewer-b-primary"],
      },
      reviewerDiversityMode: "distinct-serving-providers",
    },
  };
}

function planningEvidence(result) {
  return [
    {
      format: "openab.verification-evidence/v1",
      kind: "ScriptedPlanningResult",
      resultDigest: canonicalDigest(result),
    },
  ];
}

async function completePlanningExecution(core, result = validPlanningResult()) {
  const initial = await core.operator({
    kind: "Observe",
    principal: OPERATOR_ID,
    locale: "en",
  });
  await core.operator({
    kind: "Act",
    principal: OPERATOR_ID,
    locale: "en",
    requestId: "request:start-planning",
    offer: initial.offers[0].offer,
    action: {
      kind: "SubmitObjective",
      payload: { objective: "Prepare an execution-ready plan" },
    },
  });
  const pulled = await core.execution({
    kind: "Pull",
    agentRoleIdentity: ORCHESTRATOR_ID,
  });
  await core.execution({
    kind: "Report",
    agentRoleIdentity: ORCHESTRATOR_ID,
    factId: "fact:planning-result-1",
    directive: pulled.directive.capability,
    result,
    evidence: planningEvidence(result),
  });
  return core.operator({
    kind: "Observe",
    principal: OPERATOR_ID,
    locale: "en",
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function capsuleDigest(capsule) {
  const { capsuleDigest: ignored, ...body } = capsule;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(body)))
    .digest("hex")}`;
}

function rewriteGeneration(directory, { rewriteDatabase, rewriteManifest }) {
  const databasePath = join(directory, "runtime-core.sqlite3");
  const manifestPath = join(directory, "manifest.json");
  chmodSync(databasePath, 0o600);
  const database = new DatabaseSync(databasePath);
  try {
    rewriteDatabase(database);
  } finally {
    database.close();
  }
  chmodSync(databasePath, 0o400);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  rewriteManifest(manifest);
  const databaseBytes = readFileSync(databasePath);
  manifest.database = {
    size: databaseBytes.byteLength,
    digest: `sha256:${createHash("sha256").update(databaseBytes).digest("hex")}`,
  };
  delete manifest.manifestDigest;
  manifest.manifestDigest = canonicalDigest(manifest);
  chmodSync(manifestPath, 0o600);
  writeFileSync(manifestPath, `${JSON.stringify(canonicalize(manifest))}\n`);
  chmodSync(manifestPath, 0o400);
}

function addConflictingGeneration(recoveryRoot) {
  const generationsDirectory = join(recoveryRoot, "generations");
  const sourceName = readdirSync(generationsDirectory).find((name) => {
    const manifest = JSON.parse(
      readFileSync(join(generationsDirectory, name, "manifest.json"), "utf8"),
    );
    return manifest.cursor.revision === 1;
  });
  const conflictingDirectory = join(
    generationsDirectory,
    "00000001-e1-conflicting-head",
  );
  cpSync(join(generationsDirectory, sourceName), conflictingDirectory, {
    recursive: true,
  });
  const commitsDirectory = join(recoveryRoot, "commits");
  const originalCapsule = JSON.parse(
    readFileSync(
      join(commitsDirectory, readdirSync(commitsDirectory)[0]),
      "utf8",
    ),
  );
  const conflictingCapsule = structuredClone(originalCapsule);
  conflictingCapsule.commitId = "commit:conflicting-head";
  conflictingCapsule.request.id = "request:conflicting-head";
  conflictingCapsule.request.digest = canonicalDigest(
    conflictingCapsule.request.content,
  );
  conflictingCapsule.receipt.requestId = conflictingCapsule.request.id;
  conflictingCapsule.receipt.commitId = conflictingCapsule.commitId;
  delete conflictingCapsule.capsuleDigest;
  conflictingCapsule.capsuleDigest = capsuleDigest(conflictingCapsule);
  writeFileSync(
    join(commitsDirectory, "00000001-commit%3Aconflicting-head.json"),
    `${JSON.stringify(canonicalize(conflictingCapsule))}\n`,
  );
  rewriteGeneration(conflictingDirectory, {
    rewriteDatabase(database) {
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec("DROP TRIGGER immutable_commit_identities_update");
      database.exec("DROP TRIGGER immutable_request_receipts_update");
      database.exec("DROP TRIGGER immutable_audit_records_update");
      database.exec("DROP TRIGGER immutable_run_revisions_update");
      database
        .prepare(
          `UPDATE commit_identities
           SET commit_id = ?, request_id = ?, request_digest = ?,
               capsule_digest = ?
           WHERE commit_id = ?`,
        )
        .run(
          conflictingCapsule.commitId,
          conflictingCapsule.request.id,
          conflictingCapsule.request.digest,
          conflictingCapsule.capsuleDigest,
          originalCapsule.commitId,
        );
      database
        .prepare(
          `UPDATE request_receipts
           SET request_id = ?, request_digest = ?, receipt_json = ?,
               commit_id = ?, receipt_capsule_digest = ?
           WHERE commit_id = ?`,
        )
        .run(
          conflictingCapsule.request.id,
          conflictingCapsule.request.digest,
          JSON.stringify(canonicalize(conflictingCapsule.receipt)),
          conflictingCapsule.commitId,
          conflictingCapsule.capsuleDigest,
          originalCapsule.commitId,
        );
      database
        .prepare("UPDATE audit_records SET commit_id = ? WHERE commit_id = ?")
        .run(conflictingCapsule.commitId, originalCapsule.commitId);
      database
        .prepare("UPDATE effect_intents SET commit_id = ? WHERE commit_id = ?")
        .run(conflictingCapsule.commitId, originalCapsule.commitId);
      database
        .prepare("UPDATE run_revisions SET commit_id = ? WHERE commit_id = ?")
        .run(conflictingCapsule.commitId, originalCapsule.commitId);
      database
        .prepare(
          "UPDATE current_projection SET commit_id = ? WHERE singleton = 1",
        )
        .run(conflictingCapsule.commitId);
      database.exec("PRAGMA foreign_keys = ON");
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    },
    rewriteManifest(manifest) {
      manifest.cursor.commitId = conflictingCapsule.commitId;
    },
  });
}

function addSecondRevisionGeneration(recoveryRoot) {
  const generationsDirectory = join(recoveryRoot, "generations");
  const sourceName = readdirSync(generationsDirectory).find((name) => {
    const manifest = JSON.parse(
      readFileSync(join(generationsDirectory, name, "manifest.json"), "utf8"),
    );
    return manifest.cursor.revision === 1;
  });
  const secondDirectory = join(
    generationsDirectory,
    "00000002-e1-canonical-head",
  );
  cpSync(join(generationsDirectory, sourceName), secondDirectory, {
    recursive: true,
  });
  const commitsDirectory = join(recoveryRoot, "commits");
  const originalCapsule = JSON.parse(
    readFileSync(
      join(commitsDirectory, readdirSync(commitsDirectory)[0]),
      "utf8",
    ),
  );
  const secondCapsule = structuredClone(originalCapsule);
  secondCapsule.commitId = "commit:canonical-head-2";
  secondCapsule.predecessor = originalCapsule.commitId;
  secondCapsule.revision = 2;
  secondCapsule.request.id = "request:canonical-head-2";
  secondCapsule.request.content.action.payload.objective =
    "Canonical second revision";
  secondCapsule.request.digest = canonicalDigest(secondCapsule.request.content);
  secondCapsule.receipt.requestId = secondCapsule.request.id;
  secondCapsule.receipt.commitId = secondCapsule.commitId;
  secondCapsule.receipt.revision = secondCapsule.revision;
  secondCapsule.receipt.runId = "run:canonical-head-2";
  secondCapsule.mutations.run = {
    ...secondCapsule.mutations.run,
    id: secondCapsule.receipt.runId,
    objective: secondCapsule.request.content.action.payload.objective,
  };
  secondCapsule.audit.runId = secondCapsule.receipt.runId;
  secondCapsule.effectIntents = [];
  secondCapsule.mutations.createdOffers = [];
  delete secondCapsule.capsuleDigest;
  secondCapsule.capsuleDigest = capsuleDigest(secondCapsule);
  writeFileSync(
    join(commitsDirectory, "00000002-commit%3Acanonical-head-2.json"),
    `${JSON.stringify(canonicalize(secondCapsule))}\n`,
  );
  rewriteGeneration(secondDirectory, {
    rewriteDatabase(database) {
      database
        .prepare(
          `INSERT INTO commit_identities
             (commit_id, predecessor, revision, authority_epoch,
              schema_version, configuration_revision, configuration_digest,
              request_id, request_digest, capsule_digest)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          secondCapsule.commitId,
          secondCapsule.predecessor,
          secondCapsule.revision,
          secondCapsule.authorityEpoch,
          secondCapsule.schemaVersion,
          secondCapsule.configuration.revision,
          secondCapsule.configuration.digest,
          secondCapsule.request.id,
          secondCapsule.request.digest,
          secondCapsule.capsuleDigest,
        );
      database
        .prepare(
          `INSERT INTO runs
             (run_id, objective, stage, condition, review_round, outcome,
              created_at, created_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          secondCapsule.mutations.run.id,
          secondCapsule.mutations.run.objective,
          secondCapsule.mutations.run.stage,
          secondCapsule.mutations.run.condition,
          secondCapsule.mutations.run.reviewRound,
          secondCapsule.mutations.run.outcome,
          secondCapsule.mutations.run.createdAt,
          secondCapsule.revision,
        );
      database
        .prepare(
          `INSERT INTO request_receipts
             (request_id, request_digest, disposition, receipt_json,
              commit_id, receipt_capsule_digest)
           VALUES (?, ?, 'accepted', ?, ?, ?)`,
        )
        .run(
          secondCapsule.request.id,
          secondCapsule.request.digest,
          JSON.stringify(canonicalize(secondCapsule.receipt)),
          secondCapsule.commitId,
          secondCapsule.capsuleDigest,
        );
      database
        .prepare(
          `INSERT INTO audit_records
             (revision, commit_id, transition_kind, record_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          secondCapsule.revision,
          secondCapsule.commitId,
          secondCapsule.audit.actionKind,
          JSON.stringify(canonicalize(secondCapsule.audit)),
        );
      database
        .prepare(
          `INSERT INTO run_revisions
             (revision, commit_id, run_id, projection_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          secondCapsule.revision,
          secondCapsule.commitId,
          secondCapsule.mutations.run.id,
          JSON.stringify(canonicalize(secondCapsule.mutations.run)),
        );
      database
        .prepare(
          "UPDATE operator_offers SET consumed_revision = ? WHERE offer = ?",
        )
        .run(secondCapsule.revision, secondCapsule.mutations.consumedOffer);
      database
        .prepare(
          `UPDATE current_projection
           SET revision = ?, commit_id = ?, run_json = ?
           WHERE singleton = 1`,
        )
        .run(
          secondCapsule.revision,
          secondCapsule.commitId,
          JSON.stringify(canonicalize(secondCapsule.mutations.run)),
        );
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    },
    rewriteManifest(manifest) {
      manifest.cursor = {
        revision: secondCapsule.revision,
        commitId: secondCapsule.commitId,
      };
    },
  });
}

async function withAcceptedStorage(testBody) {
  const root = mkdtempSync(join(tmpdir(), "openab-runtime-integrity-"));
  const primaryRoot = join(root, "primary");
  const recoveryRoot = join(root, "recovery");
  mkdirSync(primaryRoot);
  mkdirSync(recoveryRoot);
  const options = runtimeCoreOptions(primaryRoot, recoveryRoot);
  let core = openRuntimeCore(options);

  try {
    const initial = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    const accepted = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:test-1",
      offer: initial.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Protect the authoritative projection" },
      },
    });
    core.close();
    core = undefined;
    await testBody({ options, primaryRoot, recoveryRoot, accepted });
  } finally {
    core?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("Observe localizes copy without changing the offered Operator Action", () =>
  withRuntimeCore(async ({ core }) => {
    const en = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    const zhTw = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "zh-TW",
    });

    assert.deepEqual(en, {
      status: "observed",
      cursor: { revision: 0, commitId: "GENESIS" },
      view: {
        locale: "en",
        authorityEpoch: 1,
        run: null,
        latestReceipt: null,
        copy: {
          status: "No active Run",
          nextAction: "Submit an objective",
        },
      },
      offers: [
        {
          kind: "SubmitObjective",
          offer: "offer:test-1",
          constraints: {
            objective: { type: "string", minLength: 1, maxLength: 4096 },
          },
        },
      ],
    });
    assert.deepEqual(zhTw, {
      ...en,
      view: {
        ...en.view,
        locale: "zh-TW",
        copy: {
          status: "沒有進行中的 Run",
          nextAction: "提交目標",
        },
      },
    });
  }));

test("Act durably creates one Planning Run before acknowledging it", () =>
  withRuntimeCore(async ({ core, reopen }) => {
    const observed = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    const reply = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:test-1",
      offer: observed.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Build a durable first Run" },
      },
    });

    const receipt = {
      status: "accepted",
      requestId: "request:test-1",
      commitId: "commit:test-1",
      revision: 1,
      actionKind: "SubmitObjective",
      runId: "run:test-1",
      acceptedAt: "2026-08-13T00:00:00.000Z",
    };
    const run = {
      id: "run:test-1",
      objective: "Build a durable first Run",
      stage: "Planning",
      condition: "Active",
      reviewRound: null,
      outcome: null,
      createdAt: "2026-08-13T00:00:00.000Z",
      planRevision: 1,
      plan: null,
      confirmedPlan: null,
      lastCommittedTransition: "SubmitObjective",
      planningExecution: {
        id: "execution:planning-test-1",
        status: "Pending",
        replacementUsed: false,
        directive: {
          format: "openab.execution-directive/v1",
          capability: "directive:planning-test-1",
          executionId: "execution:planning-test-1",
          runId: "run:test-1",
          planRevision: 1,
          agentRoleIdentity: ORCHESTRATOR_ID,
          executionProfile: PLANNING_PROFILE,
          executionContext: {
            format: "openab.execution-context/v1",
            runId: "run:test-1",
            objective: "Build a durable first Run",
            planRevision: 1,
            priorPlan: null,
            revisionGuidance: null,
          },
          effectIntent: {
            id: "effect-intent:test-1",
            kind: "StartPlanningExecution",
          },
          authorityEpoch: 1,
          deliveryGeneration: 1,
          safetyLimit: {
            durationMs: 600_000,
            startedAt: "2026-08-13T00:00:00.000Z",
            expiresAt: "2026-08-13T00:10:00.000Z",
          },
        },
      },
    };
    assert.deepEqual(reply, {
      status: "accepted",
      receipt,
      cursor: { revision: 1, commitId: "commit:test-1" },
      view: {
        locale: "en",
        authorityEpoch: 1,
        run,
        latestReceipt: receipt,
        stage: "Planning",
        condition: "Active",
        currentActor: "Orchestrator Agent",
        nextActor: "Operator",
        lastCommittedTransition: "SubmitObjective",
        planRevision: 1,
        legalActions: ["AbandonRun", "CancelRun"],
        copy: {
          status: "Run is active in Planning",
          nextAction: "Await the Orchestrator Agent's Run Plan",
        },
      },
      offers: [
        {
          kind: "AbandonRun",
          offer: "offer:planning-action-1",
          constraints: {
            reason: { type: "string", minLength: 1, maxLength: 4096 },
          },
        },
        {
          kind: "CancelRun",
          offer: "offer:planning-action-2",
          constraints: {},
        },
      ],
    });

    const restarted = reopen();
    assert.deepEqual(
      await restarted.operator({
        kind: "Observe",
        principal: OPERATOR_ID,
        locale: "en",
      }),
      {
        status: "observed",
        cursor: reply.cursor,
        view: reply.view,
        offers: reply.offers,
      },
    );
  }));

test("execution Pull exposes the immutable bounded Planning directive", () =>
  withPlanningRuntimeCore(async ({ core, reopen }) => {
    const observed = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:start-planning",
      offer: observed.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Prepare an execution-ready plan" },
      },
    });

    const pull = {
      kind: "Pull",
      agentRoleIdentity: ORCHESTRATOR_ID,
    };
    const offered = await core.execution(pull);
    assert.deepEqual(offered, {
      status: "offered",
      directive: {
        format: "openab.execution-directive/v1",
        capability: "directive:planning-test-1",
        executionId: "execution:planning-test-1",
        runId: "run:test-1",
        planRevision: 1,
        agentRoleIdentity: ORCHESTRATOR_ID,
        executionProfile: PLANNING_PROFILE,
        executionContext: {
          format: "openab.execution-context/v1",
          runId: "run:test-1",
          objective: "Prepare an execution-ready plan",
          planRevision: 1,
          priorPlan: null,
          revisionGuidance: null,
        },
        effectIntent: {
          id: "effect-intent:test-1",
          kind: "StartPlanningExecution",
        },
        authorityEpoch: 1,
        deliveryGeneration: 1,
        safetyLimit: {
          durationMs: 600_000,
          startedAt: "2026-08-13T00:00:00.000Z",
          expiresAt: "2026-08-13T00:10:00.000Z",
        },
      },
    });

    offered.directive.executionContext.objective = "mutated by caller";
    assert.equal(
      (await core.execution(pull)).directive.executionContext.objective,
      "Prepare an execution-ready plan",
    );
    assert.deepEqual(await reopen().execution(pull), {
      status: "offered",
      directive: {
        ...offered.directive,
        executionContext: {
          ...offered.directive.executionContext,
          objective: "Prepare an execution-ready plan",
        },
      },
    });
  }));

test("a validated Planning Report establishes Completion and durable Operator offers", () =>
  withPlanningRuntimeCore(async ({ core, reopen }) => {
    const initial = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:start-planning",
      offer: initial.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Prepare an execution-ready plan" },
      },
    });
    const pulled = await core.execution({
      kind: "Pull",
      agentRoleIdentity: ORCHESTRATOR_ID,
    });
    const result = validPlanningResult();

    const reported = await core.execution({
      kind: "Report",
      agentRoleIdentity: ORCHESTRATOR_ID,
      factId: "fact:planning-result-1",
      directive: pulled.directive.capability,
      result,
      evidence: planningEvidence(result),
    });

    assert.deepEqual(reported, {
      status: "accepted",
      receipt: {
        status: "accepted",
        requestId: "fact:planning-result-1",
        commitId: "commit:test-2",
        revision: 2,
        actionKind: "ReportPlanningResult",
        runId: "run:test-1",
        acceptedAt: "2026-08-13T00:00:00.000Z",
      },
    });
    const observation = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    assert.equal(observation.view.run.stage, "Planning");
    assert.equal(observation.view.run.condition, "Waiting for Operator");
    assert.equal(observation.view.run.planRevision, 1);
    assert.deepEqual(observation.view.run.plan, result.runPlan);
    assert.equal(observation.view.run.planningExecution.status, "Completed");
    assert.equal(
      observation.view.run.lastCommittedTransition,
      "ReportPlanningResult",
    );
    assert.deepEqual(
      observation.offers.map(({ kind }) => kind),
      ["AbandonRun", "CancelRun", "ConfirmPlan", "RevisePlan"],
    );

    const restarted = reopen();
    const replayed = await restarted.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    assert.deepEqual(replayed, observation);
    assert.deepEqual(
      await restarted.execution({
        kind: "Pull",
        agentRoleIdentity: ORCHESTRATOR_ID,
      }),
      { status: "idle" },
    );
  }));

test("both locales expose the same Planning authority and legal actions", () =>
  withPlanningRuntimeCore(async ({ core }) => {
    const en = await completePlanningExecution(core);
    const zhTw = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "zh-TW",
    });
    const expectedAuthority = {
      stage: "Planning",
      condition: "Waiting for Operator",
      currentActor: "Operator",
      nextActor: null,
      lastCommittedTransition: "ReportPlanningResult",
      planRevision: 1,
      legalActions: ["AbandonRun", "CancelRun", "ConfirmPlan", "RevisePlan"],
    };

    for (const [field, value] of Object.entries(expectedAuthority)) {
      assert.deepEqual(en.view[field], value);
      assert.deepEqual(zhTw.view[field], value);
    }
    assert.deepEqual(zhTw.offers, en.offers);
    assert.deepEqual(en.view.copy, {
      status: "Run Plan awaits Operator confirmation",
      nextAction: "Confirm, revise, abandon, or cancel the Run",
    });
    assert.deepEqual(zhTw.view.copy, {
      status: "Run Plan 等待 Operator 確認",
      nextAction: "確認、修訂、放棄或取消 Run",
    });
  }));

test("a scripted Report remains an observation until result and evidence validate", () =>
  withPlanningRuntimeCore(async ({ core, reopen }) => {
    const initial = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    const started = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:start-planning",
      offer: initial.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Prepare an execution-ready plan" },
      },
    });
    const pulled = await core.execution({
      kind: "Pull",
      agentRoleIdentity: ORCHESTRATOR_ID,
    });
    const result = validPlanningResult();
    const invalidRequest = {
      kind: "Report",
      agentRoleIdentity: ORCHESTRATOR_ID,
      factId: "fact:invalid-planning-result",
      directive: pulled.directive.capability,
      result,
      evidence: [
        {
          format: "openab.verification-evidence/v1",
          kind: "ScriptedPlanningResult",
          resultDigest: `sha256:${"0".repeat(64)}`,
        },
      ],
    };
    const invalid = await core.execution(invalidRequest);

    assert.equal(invalid.status, "rejected");
    assert.equal(invalid.rejection.code, "InvalidVerificationEvidence");
    assert.equal(invalid.receipt.status, "rejected");
    assert.equal(invalid.receipt.requestId, "fact:invalid-planning-result");
    const observed = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    assert.deepEqual(observed.cursor, started.cursor);
    assert.equal(observed.view.run.condition, "Active");
    assert.equal(observed.view.run.planningExecution.status, "Pending");

    const duplicate = await reopen().execution(invalidRequest);
    assert.equal(duplicate.status, "duplicate");
    assert.deepEqual(duplicate.receipt, invalid.receipt);
  }));

test("Planning expiry never establishes Execution Completion", () => {
  let now = "2026-08-13T00:00:00.000Z";
  return withPlanningRuntimeCore(
    async ({ core }) => {
      const initial = await core.operator({
        kind: "Observe",
        principal: OPERATOR_ID,
        locale: "en",
      });
      const started = await core.operator({
        kind: "Act",
        principal: OPERATOR_ID,
        locale: "en",
        requestId: "request:start-planning",
        offer: initial.offers[0].offer,
        action: {
          kind: "SubmitObjective",
          payload: { objective: "Prepare an execution-ready plan" },
        },
      });
      const directive = (
        await core.execution({
          kind: "Pull",
          agentRoleIdentity: ORCHESTRATOR_ID,
        })
      ).directive;
      now = "2026-08-13T00:10:00.000Z";

      assert.deepEqual(
        await core.execution({
          kind: "Pull",
          agentRoleIdentity: ORCHESTRATOR_ID,
        }),
        {
          status: "expired",
          executionId: "execution:planning-test-1",
          completionEstablished: false,
        },
      );
      const result = validPlanningResult();
      const late = await core.execution({
        kind: "Report",
        agentRoleIdentity: ORCHESTRATOR_ID,
        factId: "fact:late-planning-result",
        directive: directive.capability,
        result,
        evidence: planningEvidence(result),
      });
      assert.equal(late.status, "rejected");
      assert.equal(late.rejection.code, "SafetyLimitExpired");

      const observed = await core.operator({
        kind: "Observe",
        principal: OPERATOR_ID,
        locale: "en",
      });
      assert.deepEqual(observed.cursor, started.cursor);
      assert.equal(observed.view.run.planningExecution.status, "Pending");
    },
    { clock: () => now },
  );
});

test("RevisePlan creates the next Planning Execution without using a replacement", () =>
  withPlanningRuntimeCore(async ({ core, reopen }) => {
    const firstResult = validPlanningResult();
    const waiting = await completePlanningExecution(core, firstResult);
    const revise = waiting.offers.find(({ kind }) => kind === "RevisePlan");

    const revised = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:revise-plan-1",
      offer: revise.offer,
      action: {
        kind: "RevisePlan",
        payload: { guidance: "Limit scope to the public Runtime Core seam" },
      },
    });

    assert.equal(revised.status, "accepted");
    assert.deepEqual(revised.cursor, {
      revision: 3,
      commitId: "commit:test-3",
    });
    assert.equal(revised.view.run.id, "run:test-1");
    assert.equal(revised.view.run.condition, "Active");
    assert.equal(revised.view.run.planRevision, 2);
    assert.equal(revised.view.run.planningExecution.id, "execution:planning-test-2");
    assert.equal(revised.view.run.planningExecution.replacementUsed, false);
    assert.equal(
      revised.view.run.lastCommittedTransition,
      "RevisePlan",
    );

    const next = await core.execution({
      kind: "Pull",
      agentRoleIdentity: ORCHESTRATOR_ID,
    });
    assert.equal(next.status, "offered");
    assert.equal(next.directive.planRevision, 2);
    assert.deepEqual(next.directive.executionContext.priorPlan, firstResult.runPlan);
    assert.equal(
      next.directive.executionContext.revisionGuidance,
      "Limit scope to the public Runtime Core seam",
    );
    assert.equal(next.directive.effectIntent.id, "effect-intent:test-2");
    assert.equal(next.directive.capability, "directive:planning-test-2");

    const restarted = reopen();
    assert.deepEqual(
      await restarted.execution({
        kind: "Pull",
        agentRoleIdentity: ORCHESTRATOR_ID,
      }),
      next,
    );
    const secondResult = validPlanningResult({
      executionId: "execution:planning-test-2",
      planRevision: 2,
      objective: "Prepare a plan limited to the public Runtime Core seam",
    });
    const secondReport = await restarted.execution({
      kind: "Report",
      agentRoleIdentity: ORCHESTRATOR_ID,
      factId: "fact:planning-result-2",
      directive: next.directive.capability,
      result: secondResult,
      evidence: planningEvidence(secondResult),
    });
    assert.equal(secondReport.status, "accepted");
    const secondWaiting = await restarted.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    assert.equal(secondWaiting.view.run.condition, "Waiting for Operator");
    assert.equal(secondWaiting.view.run.planRevision, 2);
    assert.deepEqual(secondWaiting.view.run.plan, secondResult.runPlan);
  }));

test("ConfirmPlan freezes the complete execution authority boundary", () =>
  withPlanningRuntimeCore(async ({ core, reopen }) => {
    const result = validPlanningResult();
    const waiting = await completePlanningExecution(core, result);
    const confirm = waiting.offers.find(({ kind }) => kind === "ConfirmPlan");

    const confirmed = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:confirm-plan-1",
      offer: confirm.offer,
      action: { kind: "ConfirmPlan", payload: {} },
    });

    assert.equal(confirmed.status, "accepted");
    assert.deepEqual(confirmed.cursor, {
      revision: 3,
      commitId: "commit:test-3",
    });
    assert.equal(confirmed.view.run.stage, "Coding");
    assert.equal(confirmed.view.run.condition, "Active");
    assert.deepEqual(confirmed.view.run.confirmedPlan, {
      format: "openab.run-plan/v1",
      planRevision: 1,
      confirmedAt: "2026-08-13T00:00:00.000Z",
      ...result.runPlan,
    });
    assert.deepEqual(confirmed.offers, []);

    confirmed.view.run.confirmedPlan.scope.push("caller mutation");
    const restarted = reopen();
    const observed = await restarted.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    assert.deepEqual(observed.view.run.confirmedPlan, {
      format: "openab.run-plan/v1",
      planRevision: 1,
      confirmedAt: "2026-08-13T00:00:00.000Z",
      ...result.runPlan,
    });
  }));

test("restart verifies earlier Run revisions after later planning commits", () =>
  withPlanningRuntimeCore(async ({ core, close, options, primaryRoot }) => {
    const waiting = await completePlanningExecution(core);
    const confirm = waiting.offers.find(({ kind }) => kind === "ConfirmPlan");
    await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:confirm-plan-1",
      offer: confirm.offer,
      action: { kind: "ConfirmPlan", payload: {} },
    });
    close();

    const database = new DatabaseSync(join(primaryRoot, "runtime-core.sqlite3"));
    database
      .prepare("UPDATE runs SET objective = ? WHERE run_id = ?")
      .run("tampered earlier objective", "run:test-1");
    database.close();

    assert.throws(
      () => openRuntimeCore(options),
      /authoritative created Run differs from its capsule/,
    );
  }));

test("a material plan change after confirmation requires a Successor Run", () =>
  withPlanningRuntimeCore(async ({ core, reopen }) => {
    const waiting = await completePlanningExecution(core);
    const confirm = waiting.offers.find(({ kind }) => kind === "ConfirmPlan");
    const revise = waiting.offers.find(({ kind }) => kind === "RevisePlan");
    const confirmed = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:confirm-plan-1",
      offer: confirm.offer,
      action: { kind: "ConfirmPlan", payload: {} },
    });

    const rejected = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:change-confirmed-plan",
      offer: revise.offer,
      action: {
        kind: "RevisePlan",
        payload: { guidance: "Broaden the objective and acceptance boundary" },
      },
    });

    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.rejection.code, "SuccessorRunRequired");
    assert.deepEqual(rejected.cursor, confirmed.cursor);
    assert.equal(rejected.view.run.lastCommittedTransition, "ConfirmPlan");

    const restarted = reopen();
    const duplicate = await restarted.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "zh-TW",
      requestId: "request:change-confirmed-plan",
      offer: revise.offer,
      action: {
        kind: "RevisePlan",
        payload: { guidance: "Broaden the objective and acceptance boundary" },
      },
    });
    assert.equal(duplicate.status, "duplicate");
    assert.deepEqual(duplicate.receipt, rejected.receipt);
  }));

test("AbandonRun with no active Execution durably commits Abandoned", () =>
  withPlanningRuntimeCore(async ({ core, reopen }) => {
    const waiting = await completePlanningExecution(core);
    const abandon = waiting.offers.find(({ kind }) => kind === "AbandonRun");

    const abandoned = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:abandon-run-1",
      offer: abandon.offer,
      action: {
        kind: "AbandonRun",
        payload: { reason: "The plan is no longer worth pursuing" },
      },
    });

    assert.equal(abandoned.status, "accepted");
    assert.equal(abandoned.view.run.condition, "Terminal");
    assert.equal(abandoned.view.run.outcome, "Abandoned");
    assert.equal(abandoned.view.run.lastCommittedTransition, "AbandonRun");
    assert.deepEqual(abandoned.offers, []);

    const restarted = reopen();
    const observed = await restarted.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    assert.equal(observed.view.run.outcome, "Abandoned");
    assert.deepEqual(observed.cursor, abandoned.cursor);
  }));

test("AbandonRun with active Planning work enters cancellation convergence", () =>
  withPlanningRuntimeCore(async ({ core, reopen }) => {
    const initial = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    const active = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:start-planning",
      offer: initial.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Prepare an execution-ready plan" },
      },
    });
    assert.deepEqual(
      active.offers.map(({ kind }) => kind),
      ["AbandonRun", "CancelRun"],
    );
    const abandon = active.offers.find(({ kind }) => kind === "AbandonRun");

    const cancelling = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:abandon-active-run",
      offer: abandon.offer,
      action: {
        kind: "AbandonRun",
        payload: { reason: "Stop after active work is contained" },
      },
    });

    assert.equal(cancelling.status, "accepted");
    assert.equal(cancelling.view.run.condition, "Cancelling");
    assert.equal(cancelling.view.run.outcome, null);
    assert.equal(cancelling.view.run.abandonAfterCancellation, true);
    assert.equal(cancelling.view.run.planningExecution.status, "Pending");
    assert.deepEqual(cancelling.offers, []);
    assert.deepEqual(
      await core.execution({
        kind: "Pull",
        agentRoleIdentity: ORCHESTRATOR_ID,
      }),
      { status: "withheld", reason: "CancellationInProgress" },
    );

    const restarted = reopen();
    const observed = await restarted.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    assert.equal(observed.view.run.condition, "Cancelling");
    assert.equal(observed.view.run.outcome, null);
  }));

test("primary loss requires an explicit Restore from a disclosed recovery point", () =>
  withAcceptedStorage(async ({ options, primaryRoot, accepted }) => {
    rmSync(primaryRoot, { recursive: true });

    const recoveryCore = openRuntimeCore(options);
    try {
      const observed = await recoveryCore.operator({
        kind: "Observe",
        principal: OPERATOR_ID,
        locale: "en",
      });

      assert.equal(
        existsSync(join(primaryRoot, "runtime-core.sqlite3")),
        false,
      );
      assert.deepEqual(observed.cursor, accepted.cursor);
      assert.equal(observed.view.run, null);
      assert.equal(observed.view.recovery.status, "RecoveryRequired");
      assert.equal(observed.view.recovery.condition, "Waiting for Operator");
      assert.deepEqual(observed.view.recovery.recoveryPoints[0], {
        id: observed.view.recovery.recoveryPoints[0].id,
        sourceCursor: accepted.cursor,
        targetCursor: accepted.cursor,
        authorityEpoch: 1,
        configurationRevision: "configuration:test-1",
        effectiveConfigurationDigest: CONFIGURATION_DIGEST,
        secretReferenceGenerations: {
          "execution-worker/provider-authentication":
            "generation:test-provider-1",
        },
        capsuleTailLength: 0,
        referencedArtifactCount: 0,
      });
      assert.deepEqual(observed.offers, [
        {
          kind: "Restore",
          offer: "offer:restore-1",
          constraints: {
            recoveryPoint: {
              type: "string",
              enum: observed.view.recovery.recoveryPoints.map(
                (point) => point.id,
              ),
            },
          },
        },
      ]);
    } finally {
      recoveryCore.close();
    }
  }));

test("two independently verified generations disclose the same authoritative head", () =>
  withAcceptedStorage(async ({ options, primaryRoot, accepted }) => {
    rmSync(primaryRoot, { recursive: true });
    const recoveryCore = openRuntimeCore(options);

    try {
      const observed = await recoveryCore.operator({
        kind: "Observe",
        principal: OPERATOR_ID,
        locale: "en",
      });
      const points = observed.view.recovery.recoveryPoints;

      assert.equal(points.length, 2);
      assert.deepEqual(
        points.map((point) => point.sourceCursor),
        [accepted.cursor, { revision: 0, commitId: "GENESIS" }],
      );
      assert.deepEqual(
        points.map((point) => point.targetCursor),
        [accepted.cursor, accepted.cursor],
      );
      assert.deepEqual(
        observed.offers[0].constraints.recoveryPoint.enum,
        points.map((point) => point.id),
      );
    } finally {
      recoveryCore.close();
    }
  }));

test("an unavailable highest authority epoch never offers a matching older epoch", () =>
  withAcceptedStorage(async ({ options, primaryRoot, recoveryRoot, accepted }) => {
    rmSync(primaryRoot, { recursive: true });
    let recoveryCore = openRuntimeCore(options);
    const observed = await recoveryCore.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    await recoveryCore.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:create-epoch-two",
      offer: observed.offers[0].offer,
      action: {
        kind: "Restore",
        payload: {
          recoveryPoint: observed.view.recovery.recoveryPoints[0].id,
        },
      },
    });
    recoveryCore.close();

    const unavailableConfiguration = {
      revision: "configuration:epoch-two-unavailable",
      digest: `sha256:${"b".repeat(64)}`,
      secretReferenceGenerations: {
        "execution-worker/provider-authentication":
          "generation:epoch-two-unavailable",
      },
    };
    const generationsDirectory = join(recoveryRoot, "generations");
    for (const name of readdirSync(generationsDirectory)) {
      const directory = join(generationsDirectory, name);
      const manifest = JSON.parse(
        readFileSync(join(directory, "manifest.json"), "utf8"),
      );
      if (manifest.authorityEpoch !== 2) {
        continue;
      }
      rewriteGeneration(directory, {
        rewriteDatabase(database) {
          const update = database.prepare(
            "UPDATE metadata SET value = ? WHERE key = ?",
          );
          update.run(
            unavailableConfiguration.revision,
            "configurationRevision",
          );
          update.run(
            unavailableConfiguration.digest,
            "effectiveConfigurationDigest",
          );
          update.run(
            JSON.stringify(
              unavailableConfiguration.secretReferenceGenerations,
            ),
            "secretReferenceGenerations",
          );
        },
        rewriteManifest(candidate) {
          candidate.configuration = unavailableConfiguration;
        },
      });
    }
    rmSync(primaryRoot, { recursive: true });

    recoveryCore = openRuntimeCore(options);
    try {
      const waiting = await recoveryCore.operator({
        kind: "Observe",
        principal: OPERATOR_ID,
        locale: "en",
      });
      assert.deepEqual(waiting.cursor, accepted.cursor);
      assert.equal(waiting.view.authorityEpoch, 2);
      assert.deepEqual(waiting.view.recovery.recoveryPoints, []);
      assert.deepEqual(waiting.offers, []);
      assert.deepEqual(waiting.view.recovery.unavailableRecoveryPoints, [
        {
          sourceCursor: accepted.cursor,
          reason: "ConfigurationOrSecretGenerationUnavailable",
          requiredConfigurationRevision: unavailableConfiguration.revision,
          requiredEffectiveConfigurationDigest:
            unavailableConfiguration.digest,
          requiredSecretReferenceGenerations:
            unavailableConfiguration.secretReferenceGenerations,
        },
      ]);
    } finally {
      recoveryCore.close();
    }
  }));

test("conflicting heads in the highest authority epoch fail closed", () =>
  withAcceptedStorage(async ({ options, primaryRoot, recoveryRoot }) => {
    rmSync(primaryRoot, { recursive: true });
    addConflictingGeneration(recoveryRoot);

    assert.throws(
      () => openRuntimeCore(options),
      /conflicting authoritative recovery heads/,
    );
  }));

test("a lower-revision fork in the highest authority epoch fails closed", () =>
  withAcceptedStorage(async ({ options, primaryRoot, recoveryRoot }) => {
    rmSync(primaryRoot, { recursive: true });
    addSecondRevisionGeneration(recoveryRoot);
    addConflictingGeneration(recoveryRoot);

    assert.throws(
      () => openRuntimeCore(options),
      /conflicting authoritative recovery heads/,
    );
  }));

test("an invalid RecoveryRequired Act has a durable rejected receipt", () =>
  withAcceptedStorage(async ({ options, primaryRoot, accepted }) => {
    rmSync(primaryRoot, { recursive: true });
    const recoveryCore = openRuntimeCore(options);
    try {
      const observed = await recoveryCore.operator({
        kind: "Observe",
        principal: OPERATOR_ID,
        locale: "en",
      });
      const invalid = {
        kind: "Act",
        principal: OPERATOR_ID,
        locale: "en",
        requestId: "request:invalid-recovery-act",
        offer: "offer:not-offered",
        action: {
          kind: "Restore",
          payload: {
            recoveryPoint: observed.view.recovery.recoveryPoints[0].id,
          },
        },
      };

      const rejected = await recoveryCore.operator(invalid);
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.rejection.code, "MismatchedOffer");
      assert.equal(rejected.receipt.status, "rejected");
      assert.deepEqual(rejected.cursor, accepted.cursor);
      assert.equal(rejected.view.recovery.status, "RecoveryRequired");
      assert.deepEqual(rejected.offers, observed.offers);

      const unofferedPoint = {
        ...invalid,
        requestId: "request:unoffered-recovery-point",
        offer: observed.offers[0].offer,
        action: {
          kind: "Restore",
          payload: { recoveryPoint: "recovery-point:not-offered" },
        },
      };
      const rejectedPoint = await recoveryCore.operator(unofferedPoint);
      assert.equal(rejectedPoint.status, "rejected");
      assert.equal(rejectedPoint.rejection.code, "MismatchedOffer");
      assert.deepEqual(rejectedPoint.cursor, accepted.cursor);

      recoveryCore.close();
      const reopened = openRuntimeCore(options);
      try {
        const duplicate = await reopened.operator(invalid);
        assert.equal(duplicate.status, "duplicate");
        assert.deepEqual(duplicate.receipt, rejected.receipt);
        assert.equal(duplicate.view.recovery.status, "RecoveryRequired");

        const refreshed = await reopened.operator({
          kind: "Observe",
          principal: OPERATOR_ID,
          locale: "en",
        });
        await reopened.operator({
          kind: "Act",
          principal: OPERATOR_ID,
          locale: "en",
          requestId: "request:restore-after-rejection",
          offer: refreshed.offers[0].offer,
          action: {
            kind: "Restore",
            payload: {
              recoveryPoint: refreshed.view.recovery.recoveryPoints[0].id,
            },
          },
        });
        const afterRestore = await reopened.operator(invalid);
        assert.equal(afterRestore.status, "duplicate");
        assert.deepEqual(afterRestore.receipt, rejected.receipt);
        const pointAfterRestore = await reopened.operator(unofferedPoint);
        assert.equal(pointAfterRestore.status, "duplicate");
        assert.deepEqual(pointAfterRestore.receipt, rejectedPoint.receipt);
      } finally {
        reopened.close();
      }
    } finally {
      recoveryCore.close();
    }
  }));

test("Restore fences capabilities from the earlier authority epoch", async () => {
  const root = mkdtempSync(join(tmpdir(), "openab-restore-fencing-"));
  const primaryRoot = join(root, "primary");
  const recoveryRoot = join(root, "recovery");
  mkdirSync(primaryRoot);
  mkdirSync(recoveryRoot);
  const options = runtimeCoreOptions(primaryRoot, recoveryRoot);
  let core = openRuntimeCore(options);

  try {
    const beforeLoss = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    core.close();
    rmSync(primaryRoot, { recursive: true });
    core = openRuntimeCore(options);
    const recovery = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    assert.equal(recovery.offers[0].offer, "offer:restore-1");

    const restored = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:restore-genesis",
      offer: recovery.offers[0].offer,
      action: {
        kind: "Restore",
        payload: {
          recoveryPoint: recovery.view.recovery.recoveryPoints[0].id,
        },
      },
    });
    assert.equal(restored.view.authorityEpoch, 2);
    assert.equal(restored.view.recovery, undefined);
    assert.equal(restored.offers[0].offer, "offer:post-restore-1");

    const fenced = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:old-epoch-capability",
      offer: beforeLoss.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Do not advance under epoch one" },
      },
    });
    assert.equal(fenced.status, "rejected");
    assert.equal(fenced.rejection.code, "StaleOffer");
    assert.deepEqual(fenced.cursor, { revision: 0, commitId: "GENESIS" });
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Restore atomically activates the acknowledged Run under a new authority epoch", () =>
  withAcceptedStorage(async ({ options, primaryRoot, recoveryRoot, accepted }) => {
    rmSync(primaryRoot, { recursive: true });
    let recoveryCore = openRuntimeCore(options);

    try {
      const observed = await recoveryCore.operator({
        kind: "Observe",
        principal: OPERATOR_ID,
        locale: "en",
      });
      const recoveryPoint = observed.view.recovery.recoveryPoints[0];
      const request = {
        kind: "Act",
        principal: OPERATOR_ID,
        locale: "en",
        requestId: "request:restore-1",
        offer: observed.offers[0].offer,
        action: {
          kind: "Restore",
          payload: { recoveryPoint: recoveryPoint.id },
        },
      };

      const restored = await recoveryCore.operator(request);

      assert.equal(restored.status, "accepted");
      assert.deepEqual(restored.cursor, accepted.cursor);
      assert.deepEqual(restored.view.run, accepted.view.run);
      assert.deepEqual(restored.view.latestReceipt, accepted.receipt);
      assert.equal(restored.view.authorityEpoch, 2);
      assert.deepEqual(restored.view.recovery, {
        status: "Reconciliation",
        condition: "Active",
        authorityEpoch: 2,
        sourceRecoveryPoint: recoveryPoint.id,
        pendingEffectIntentIds: ["effect-intent:test-1"],
      });
      assert.deepEqual(restored.view.copy, {
        status: "Run restoration requires Reconciliation",
        nextAction: "Reconcile active or uncertain effects before continuing",
      });
      assert.deepEqual(restored.receipt, {
        status: "accepted",
        requestId: "request:restore-1",
        actionKind: "Restore",
        recoveryPoint: recoveryPoint.id,
        cursor: accepted.cursor,
        authorityEpoch: 2,
        recoveryGate: "Reconciliation",
        restoredAt: "2026-08-13T00:00:00.000Z",
      });
      assert.deepEqual(restored.offers, []);
      assert.equal(
        existsSync(join(primaryRoot, "runtime-core.sqlite3")),
        true,
      );
      assert.equal(
        readdirSync(join(recoveryRoot, "activation-completions")).length,
        1,
      );

      recoveryCore.close();
      rmSync(primaryRoot, { recursive: true });
      recoveryCore = openRuntimeCore(options);
      const completedReplay = await recoveryCore.operator(request);
      assert.equal(completedReplay.status, "duplicate");
      assert.deepEqual(completedReplay.receipt, restored.receipt);
      assert.equal(
        existsSync(join(primaryRoot, "runtime-core.sqlite3")),
        false,
      );

      recoveryCore.close();
      recoveryCore = openRuntimeCore(options);
      const replayed = await recoveryCore.operator(request);
      assert.equal(replayed.status, "duplicate");
      assert.deepEqual(replayed.receipt, restored.receipt);
      assert.deepEqual(replayed.cursor, accepted.cursor);
      assert.equal(replayed.view.authorityEpoch, 2);
      assert.deepEqual(replayed.view.recovery, completedReplay.view.recovery);

      const conflicting = await recoveryCore.operator({
        ...request,
        action: {
          kind: "Restore",
          payload: { recoveryPoint: "recovery-point:different" },
        },
      });
      assert.equal(conflicting.status, "rejected");
      assert.equal(conflicting.rejection.code, "RequestIdConflict");
      assert.deepEqual(conflicting.cursor, accepted.cursor);

      recoveryCore.close();
      recoveryCore = openRuntimeCore(options);
      const replayedConflict = await recoveryCore.operator({
        ...request,
        action: {
          kind: "Restore",
          payload: { recoveryPoint: "recovery-point:different" },
        },
      });
      assert.equal(replayedConflict.status, "duplicate");
      assert.deepEqual(replayedConflict.receipt, conflicting.receipt);
    } finally {
      recoveryCore.close();
    }
  }));

test("Restore applies a contiguous capsule tail when the latest generation was not created", () =>
  withAcceptedStorage(async ({ options, primaryRoot, recoveryRoot, accepted }) => {
    const generationsDirectory = join(recoveryRoot, "generations");
    const generationNames = readdirSync(generationsDirectory).sort();
    assert.equal(generationNames.length, 2);
    rmSync(join(generationsDirectory, generationNames[1]), {
      recursive: true,
    });
    rmSync(primaryRoot, { recursive: true });

    const recoveryCore = openRuntimeCore(options);
    try {
      const observed = await recoveryCore.operator({
        kind: "Observe",
        principal: OPERATOR_ID,
        locale: "en",
      });
      const [point] = observed.view.recovery.recoveryPoints;
      assert.deepEqual(point.sourceCursor, {
        revision: 0,
        commitId: "GENESIS",
      });
      assert.deepEqual(point.targetCursor, accepted.cursor);
      assert.equal(point.capsuleTailLength, 1);

      const restored = await recoveryCore.operator({
        kind: "Act",
        principal: OPERATOR_ID,
        locale: "en",
        requestId: "request:restore-from-tail",
        offer: observed.offers[0].offer,
        action: {
          kind: "Restore",
          payload: { recoveryPoint: point.id },
        },
      });
      assert.deepEqual(restored.cursor, accepted.cursor);
      assert.deepEqual(restored.view.run, accepted.view.run);
      assert.deepEqual(restored.view.latestReceipt, accepted.receipt);
      assert.equal(restored.view.authorityEpoch, 2);
    } finally {
      recoveryCore.close();
    }
  }));

test(
  "Restore faults safely during capsule-tail and artifact reconstruction",
  { skip: process.platform === "win32" },
  () => {
  const root = mkdtempSync(join(tmpdir(), "openab-artifact-restore-"));
  const primaryRoot = join(root, "primary");
  const recoveryRoot = join(root, "recovery");
  mkdirSync(primaryRoot);
  mkdirSync(recoveryRoot);
  const constraints = {
    objective: { type: "string", minLength: 1, maxLength: 4096 },
  };
  const initialOffer = {
    offer: "offer:artifact-1",
    principal: OPERATOR_ID,
    revision: 0,
    authorityEpoch: 1,
    actionKind: "SubmitObjective",
    constraints,
    consumedRevision: null,
  };
  const options = {
    primaryRoot,
    recoveryRoot,
    operatorIdentity: OPERATOR_ID,
    configurationRevision: "configuration:test-1",
    effectiveConfigurationDigest: CONFIGURATION_DIGEST,
    secretReferenceGenerations: {},
    initialOffer,
  };
  const artifactBytes = Buffer.from("immutable review target bytes");
  const artifactDigest = `sha256:${createHash("sha256")
    .update(artifactBytes)
    .digest("hex")}`;
  const requestContent = {
    principal: OPERATOR_ID,
    offer: initialOffer.offer,
    action: {
      kind: "SubmitObjective",
      payload: { objective: "Restore the referenced artifact" },
    },
  };
  let durability = openDurability(options);
  const primaryObjectDirectory = join(
    primaryRoot,
    "objects",
    "sha256",
    artifactDigest.slice(7, 9),
  );

  function restore(recoveryPoint, requestId, restoredAt) {
    const request = {
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId,
      offer: "offer:artifact-restore",
      action: {
        kind: "Restore",
        payload: { recoveryPoint: recoveryPoint.id },
      },
    };
    return durability.restore({
      request,
      requestDigest: canonicalDigest({
        principal: request.principal,
        offer: request.offer,
        action: request.action,
      }),
      recoveryPointId: recoveryPoint.id,
      restoredAt,
      replacementOffer: initialOffer,
    });
  }

  try {
    durability.act((transaction) =>
      transaction.commit({
        commitId: "commit:artifact-1",
        predecessor: "GENESIS",
        revision: 1,
        requestId: "request:artifact-1",
        requestDigest: canonicalDigest(requestContent),
        requestContent,
        receipt: {
          status: "accepted",
          requestId: "request:artifact-1",
          commitId: "commit:artifact-1",
          revision: 1,
          actionKind: "SubmitObjective",
          runId: "run:artifact-1",
          acceptedAt: "2026-08-13T00:00:00.000Z",
        },
        run: {
          id: "run:artifact-1",
          objective: "Restore the referenced artifact",
          stage: "Planning",
          condition: "Active",
          reviewRound: null,
          outcome: null,
          createdAt: "2026-08-13T00:00:00.000Z",
        },
        consumedOffer: initialOffer.offer,
        offerConstraintsDigest: canonicalDigest(constraints),
        audit: {
          actionKind: "SubmitObjective",
          principal: OPERATOR_ID,
          runId: "run:artifact-1",
          recordedAt: "2026-08-13T00:00:00.000Z",
        },
        effectIntents: [],
        artifacts: [
          {
            digest: artifactDigest,
            size: artifactBytes.byteLength,
            bytes: artifactBytes,
          },
        ],
      }),
    );
    durability.close();
    const generationsDirectory = join(recoveryRoot, "generations");
    const latestGeneration = readdirSync(generationsDirectory).find((name) => {
      const manifest = JSON.parse(
        readFileSync(join(generationsDirectory, name, "manifest.json"), "utf8"),
      );
      return manifest.cursor.revision === 1;
    });
    rmSync(join(generationsDirectory, latestGeneration), { recursive: true });
    rmSync(primaryRoot, { recursive: true });

    durability = openDurability(options);
    const recovery = durability.inspect().recovery;
    assert.equal(recovery.recoveryPoints[0].referencedArtifactCount, 1);
    assert.equal(recovery.recoveryPoints[0].capsuleTailLength, 1);
    mkdirSync(primaryObjectDirectory, { recursive: true });
    chmodSync(primaryObjectDirectory, 0o500);
    assert.throws(
      () =>
        restore(
          recovery.recoveryPoints[0],
          "request:tail-artifact-fault",
          "2026-08-13T00:00:01.000Z",
        ),
      (error) => error?.code === "EACCES",
    );
    assert.equal(existsSync(join(primaryRoot, "runtime-core.sqlite3")), false);
    chmodSync(primaryObjectDirectory, 0o700);
    rmSync(join(primaryRoot, "objects"), { recursive: true });
    restore(
      recovery.recoveryPoints[0],
      "request:artifact-tail-restore",
      "2026-08-13T00:00:02.000Z",
    );
    durability.close();

    const objectPath = join(
      primaryRoot,
      "objects",
      "sha256",
      artifactDigest.slice(7, 9),
      artifactDigest.slice(9),
    );
    assert.deepEqual(readFileSync(objectPath), artifactBytes);

    rmSync(primaryRoot, { recursive: true });
    durability = openDurability(options);
    const generatedPoint = durability.inspect().recovery.recoveryPoints[0];
    assert.equal(generatedPoint.capsuleTailLength, 0);
    mkdirSync(primaryObjectDirectory, { recursive: true });
    chmodSync(primaryObjectDirectory, 0o500);
    assert.throws(
      () =>
        restore(
          generatedPoint,
          "request:generation-artifact-fault",
          "2026-08-13T00:00:03.000Z",
        ),
      (error) => error?.code === "EACCES",
    );
    assert.equal(existsSync(join(primaryRoot, "runtime-core.sqlite3")), false);
    chmodSync(primaryObjectDirectory, 0o700);
    rmSync(join(primaryRoot, "objects"), { recursive: true });
    restore(
      generatedPoint,
      "request:generation-artifact-restore",
      "2026-08-13T00:00:04.000Z",
    );
    durability.close();
    assert.deepEqual(readFileSync(objectPath), artifactBytes);

    const recoveryObjectPath = join(
      recoveryRoot,
      "objects",
      "sha256",
      artifactDigest.slice(7, 9),
      artifactDigest.slice(9),
    );
    rmSync(recoveryObjectPath);
    rmSync(primaryRoot, { recursive: true });
    durability = openDurability(options);
    assert.deepEqual(durability.inspect().recovery.recoveryPoints, []);
    assert.equal(
      existsSync(join(primaryRoot, "runtime-core.sqlite3")),
      false,
    );
  } finally {
    if (existsSync(primaryObjectDirectory)) {
      chmodSync(primaryObjectDirectory, 0o700);
    }
    durability.close();
    rmSync(root, { recursive: true, force: true });
  }
  },
);

test("missing configuration or secret-reference generations wait without weakening the Run", () =>
  withAcceptedStorage(async ({ options, primaryRoot, accepted }) => {
    rmSync(primaryRoot, { recursive: true });
    const unavailableOptions = {
      ...options,
      configurationRevision: "configuration:unavailable",
      effectiveConfigurationDigest: `sha256:${"b".repeat(64)}`,
      secretReferenceGenerations: {
        "execution-worker/provider-authentication":
          "generation:unavailable-provider",
      },
    };
    const recoveryCore = openRuntimeCore(unavailableOptions);

    try {
      const observed = await recoveryCore.operator({
        kind: "Observe",
        principal: OPERATOR_ID,
        locale: "en",
      });

      assert.equal(observed.view.recovery.status, "RecoveryRequired");
      assert.equal(observed.view.recovery.condition, "Waiting for Operator");
      assert.deepEqual(observed.view.recovery.recoveryPoints, []);
      assert.deepEqual(observed.view.recovery.unavailableRecoveryPoints, [
        {
          sourceCursor: accepted.cursor,
          reason: "ConfigurationOrSecretGenerationUnavailable",
          requiredConfigurationRevision: "configuration:test-1",
          requiredEffectiveConfigurationDigest: CONFIGURATION_DIGEST,
          requiredSecretReferenceGenerations: {
            "execution-worker/provider-authentication":
              "generation:test-provider-1",
          },
        },
      ]);
      assert.deepEqual(observed.offers, []);
      assert.equal(
        existsSync(join(primaryRoot, "runtime-core.sqlite3")),
        false,
      );
    } finally {
      recoveryCore.close();
    }
  }));

test(
  "failed Restore activation leaves primary absent and permits an evidence-led retry",
  { skip: process.platform === "win32" },
  () =>
    withAcceptedStorage(async ({ options, primaryRoot, accepted }) => {
      rmSync(primaryRoot, { recursive: true });
      mkdirSync(primaryRoot);
      const recoveryCore = openRuntimeCore(options);

      try {
        const observed = await recoveryCore.operator({
          kind: "Observe",
          principal: OPERATOR_ID,
          locale: "en",
        });
        const recoveryPoint = observed.view.recovery.recoveryPoints[0];
        const request = {
          kind: "Act",
          principal: OPERATOR_ID,
          locale: "en",
          requestId: "request:restore-after-activation-fault",
          offer: observed.offers[0].offer,
          action: {
            kind: "Restore",
            payload: { recoveryPoint: recoveryPoint.id },
          },
        };

        chmodSync(primaryRoot, 0o500);
        await assert.rejects(
          recoveryCore.operator(request),
          (error) => error?.code === "EACCES",
        );
        assert.equal(
          existsSync(join(primaryRoot, "runtime-core.sqlite3")),
          false,
        );

        chmodSync(primaryRoot, 0o700);
        const restored = await recoveryCore.operator(request);
        assert.equal(restored.status, "accepted");
        assert.deepEqual(restored.cursor, accepted.cursor);
        assert.equal(restored.view.authorityEpoch, 2);
      } finally {
        chmodSync(primaryRoot, 0o700);
        recoveryCore.close();
      }
    }),
);

test("Restore re-verifies a selected generation if recovery changes after Observe", () =>
  withAcceptedStorage(async ({ options, primaryRoot, recoveryRoot }) => {
    rmSync(primaryRoot, { recursive: true });
    const recoveryCore = openRuntimeCore(options);

    try {
      const observed = await recoveryCore.operator({
        kind: "Observe",
        principal: OPERATOR_ID,
        locale: "en",
      });
      const generationsDirectory = join(recoveryRoot, "generations");
      const selectedGeneration = readdirSync(generationsDirectory).sort().at(-1);
      const manifestPath = join(
        generationsDirectory,
        selectedGeneration,
        "manifest.json",
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.configuration.revision = "configuration:changed-after-observe";
      chmodSync(manifestPath, 0o600);
      writeFileSync(manifestPath, JSON.stringify(manifest));

      await assert.rejects(
        recoveryCore.operator({
          kind: "Act",
          principal: OPERATOR_ID,
          locale: "en",
          requestId: "request:changed-recovery-set",
          offer: observed.offers[0].offer,
          action: {
            kind: "Restore",
            payload: {
              recoveryPoint: observed.view.recovery.recoveryPoints[0].id,
            },
          },
        }),
        /recovery point changed after Observe/,
      );
      assert.equal(
        existsSync(join(primaryRoot, "runtime-core.sqlite3")),
        false,
      );
    } finally {
      recoveryCore.close();
    }
  }));

test(
  "new authority epoch enters recovery storage before atomic activation",
  { skip: process.platform === "win32" },
  () =>
    withAcceptedStorage(async ({ options, primaryRoot, recoveryRoot }) => {
      rmSync(primaryRoot, { recursive: true });
      const recoveryCore = openRuntimeCore(options);
      const generationsDirectory = join(recoveryRoot, "generations");

      try {
        const observed = await recoveryCore.operator({
          kind: "Observe",
          principal: OPERATOR_ID,
          locale: "en",
        });
        chmodSync(generationsDirectory, 0o500);

        await assert.rejects(
          recoveryCore.operator({
            kind: "Act",
            principal: OPERATOR_ID,
            locale: "en",
            requestId: "request:generation-before-activation",
            offer: observed.offers[0].offer,
            action: {
              kind: "Restore",
              payload: {
                recoveryPoint: observed.view.recovery.recoveryPoints[0].id,
              },
            },
          }),
          (error) => error?.code === "EACCES",
        );
        assert.equal(
          existsSync(join(primaryRoot, "runtime-core.sqlite3")),
          false,
        );
      } finally {
        chmodSync(generationsDirectory, 0o700);
        recoveryCore.close();
      }
    }),
);

test("an interruption after generation durability cannot expose a partial activation", () =>
  withAcceptedStorage(async ({ options, primaryRoot, recoveryRoot, accepted }) => {
    rmSync(primaryRoot, { recursive: true });
    let recoveryCore = openRuntimeCore(options);
    const observed = await recoveryCore.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    const request = {
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:obstruct-atomic-activation",
      offer: observed.offers[0].offer,
      action: {
        kind: "Restore",
        payload: {
          recoveryPoint: observed.view.recovery.recoveryPoints[0].id,
        },
      },
    };
    const worker = new Worker(
      new URL(
        "../test-support/runtime-core-activation-obstructor.mjs",
        import.meta.url,
      ),
      { workerData: { primaryRoot } },
    );
    assert.deepEqual((await once(worker, "message"))[0], { status: "ready" });
    const obstruction = once(worker, "message").then(([message]) => message);

    try {
      await assert.rejects(
        recoveryCore.operator(request),
        (error) => error?.code === "EISDIR" || error?.code === "ENOTEMPTY",
      );
      assert.deepEqual(await obstruction, { status: "obstructed" });
      const generationManifests = readdirSync(
        join(recoveryRoot, "generations"),
      ).map((name) =>
        JSON.parse(
          readFileSync(
            join(recoveryRoot, "generations", name, "manifest.json"),
            "utf8",
          ),
        ),
      );
      assert.equal(
        generationManifests.some((manifest) => manifest.authorityEpoch === 2),
        true,
      );
      rmSync(join(primaryRoot, "runtime-core.sqlite3"), { recursive: true });
      assert.equal(
        existsSync(join(primaryRoot, "runtime-core.sqlite3")),
        false,
      );

      recoveryCore.close();
      recoveryCore = openRuntimeCore(options);
      const reconnected = await recoveryCore.operator({
        kind: "Observe",
        principal: OPERATOR_ID,
        locale: "en",
      });
      assert.equal(reconnected.view.authorityEpoch, 2);
      assert.deepEqual(reconnected.cursor, accepted.cursor);
      const restored = await recoveryCore.operator(request);
      assert.equal(restored.status, "accepted");
      assert.equal(restored.receipt.requestId, request.requestId);
      assert.equal(restored.view.authorityEpoch, 2);
      assert.deepEqual(restored.cursor, accepted.cursor);
      assert.equal(
        existsSync(join(primaryRoot, "runtime-core.sqlite3")),
        true,
      );
    } finally {
      await worker.terminate();
      recoveryCore.close();
      rmSync(join(primaryRoot, "runtime-core.sqlite3"), {
        recursive: true,
        force: true,
      });
    }
  }));

test("exact replay returns the original receipt without another transition", () =>
  withRuntimeCore(async ({ core }) => {
    const observed = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    const action = {
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:test-1",
      offer: observed.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Replay this objective exactly" },
      },
    };

    const accepted = await core.operator(action);
    const duplicate = await core.operator({ ...action, locale: "zh-TW" });

    assert.equal(duplicate.status, "duplicate");
    assert.deepEqual(duplicate.receipt, accepted.receipt);
    assert.deepEqual(duplicate.cursor, accepted.cursor);
    assert.deepEqual(duplicate.view.run, accepted.view.run);
    assert.deepEqual(duplicate.view.latestReceipt, accepted.receipt);
    assert.equal(duplicate.view.locale, "zh-TW");
    assert.deepEqual(duplicate.view.copy, {
      status: "Run 正在 Planning 階段進行",
      nextAction: "等待 Orchestrator Agent 提出 Run Plan",
    });
    assert.deepEqual(duplicate.offers, accepted.offers);
  }));

test("conflicting request IDs and stale or mismatched offers do not commit", () =>
  withRuntimeCore(async ({ core, reopen }) => {
    const observed = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    const accepted = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:test-1",
      offer: observed.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "The authoritative objective" },
      },
    });

    const conflictingRequest = {
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:test-1",
      offer: observed.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Different content" },
      },
    };
    const conflict = await core.operator(conflictingRequest);
    assert.equal(conflict.status, "rejected");
    assert.equal(conflict.rejection.code, "RequestIdConflict");
    assert.deepEqual(conflict.cursor, accepted.cursor);

    const stale = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:test-2",
      offer: observed.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "A second objective" },
      },
    });
    assert.equal(stale.status, "rejected");
    assert.equal(stale.rejection.code, "StaleOffer");
    assert.deepEqual(stale.cursor, accepted.cursor);

    const mismatched = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:test-3",
      offer: "offer:from-another-runtime-core",
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Another second objective" },
      },
    });
    assert.equal(mismatched.status, "rejected");
    assert.equal(mismatched.rejection.code, "MismatchedOffer");
    assert.deepEqual(mismatched.cursor, accepted.cursor);

    const finalView = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    assert.deepEqual(finalView.cursor, accepted.cursor);
    assert.deepEqual(finalView.view.run, accepted.view.run);
    assert.deepEqual(finalView.offers, accepted.offers);

    const restarted = reopen();
    const replayedConflict = await restarted.operator(conflictingRequest);
    assert.equal(replayedConflict.status, "duplicate");
    assert.deepEqual(replayedConflict.receipt, conflict.receipt);
    assert.deepEqual(replayedConflict.cursor, accepted.cursor);
  }));

test("restart completes the one recovery-first capsule that SQLite has not committed", async () => {
  const root = mkdtempSync(join(tmpdir(), "openab-runtime-recovery-"));
  const primaryRoot = join(root, "primary");
  const recoveryRoot = join(root, "recovery");
  mkdirSync(primaryRoot);
  mkdirSync(recoveryRoot);
  const options = runtimeCoreOptions(primaryRoot, recoveryRoot);
  const databasePath = join(primaryRoot, "runtime-core.sqlite3");
  const genesisDatabase = join(root, "genesis.sqlite3");
  let core;

  try {
    core = openRuntimeCore(options);
    const initial = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    core.close();
    core = undefined;
    copyFileSync(databasePath, genesisDatabase);

    core = openRuntimeCore(options);
    const accepted = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:test-1",
      offer: initial.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Recover the prepared transition" },
      },
    });
    core.close();
    core = undefined;

    copyFileSync(genesisDatabase, databasePath);
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    core = openRuntimeCore(options);

    const recovered = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    assert.deepEqual(recovered.cursor, accepted.cursor);
    assert.deepEqual(recovered.view.run, accepted.view.run);
    assert.deepEqual(recovered.view.latestReceipt, accepted.receipt);
    assert.deepEqual(recovered.offers, accepted.offers);
  } finally {
    core?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart rejects an authoritative commit whose recovery capsule was changed", () =>
  withRuntimeCore(async ({ core, recoveryRoot }) => {
    const initial = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:test-1",
      offer: initial.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Detect recovery corruption" },
      },
    });
    const commitsDirectory = join(recoveryRoot, "commits");
    const [capsuleName] = readdirSync(commitsDirectory);
    const capsulePath = join(commitsDirectory, capsuleName);
    const capsule = JSON.parse(readFileSync(capsulePath, "utf8"));
    capsule.receipt.runId = "run:tampered";
    chmodSync(capsulePath, 0o600);
    writeFileSync(capsulePath, JSON.stringify(capsule));

    assert.throws(
      () => openRuntimeCore(runtimeCoreOptions(
        join(recoveryRoot, "..", "primary"),
        recoveryRoot,
      )),
      /recovery capsule digest does not verify/,
    );
  }));

test("a rejected Act has a durable receipt that exact replay can recover", () =>
  withRuntimeCore(async ({ core, reopen }) => {
    const rejectedRequest = {
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:rejected-1",
      offer: "offer:from-another-runtime-core",
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Do not accept this objective" },
      },
    };
    const rejected = await core.operator(rejectedRequest);

    assert.equal(rejected.status, "rejected");
    assert.deepEqual(rejected.receipt, {
      status: "rejected",
      requestId: "request:rejected-1",
      actionKind: "SubmitObjective",
      cursor: { revision: 0, commitId: "GENESIS" },
      rejection: rejected.rejection,
      rejectedAt: "2026-08-13T00:00:00.000Z",
    });
    assert.deepEqual(rejected.cursor, { revision: 0, commitId: "GENESIS" });

    const restarted = reopen();
    const replayed = await restarted.operator({
      ...rejectedRequest,
      locale: "zh-TW",
    });
    assert.equal(replayed.status, "duplicate");
    assert.deepEqual(replayed.receipt, rejected.receipt);
    assert.deepEqual(replayed.cursor, rejected.cursor);
    assert.equal(replayed.view.locale, "zh-TW");
  }));

test("restart rejects a changed authoritative SQLite Run projection", () =>
  withAcceptedStorage(({ options, primaryRoot }) => {
    const database = new DatabaseSync(
      join(primaryRoot, "runtime-core.sqlite3"),
    );
    const projection = database
      .prepare("SELECT run_json FROM current_projection WHERE singleton = 1")
      .get();
    const changedRun = JSON.parse(projection.run_json);
    changedRun.objective = "A changed projection";
    database
      .prepare(
        "UPDATE current_projection SET run_json = ? WHERE singleton = 1",
      )
      .run(JSON.stringify(changedRun));
    database.close();

    assert.throws(
      () => openRuntimeCore(options),
      /authoritative current projection differs from its capsule/,
    );
  }));

test("restart rejects a current projection revision that differs from its capsule", () =>
  withAcceptedStorage(({ options, primaryRoot }) => {
    const database = new DatabaseSync(
      join(primaryRoot, "runtime-core.sqlite3"),
    );
    database
      .prepare(
        "UPDATE current_projection SET revision = 99 WHERE singleton = 1",
      )
      .run();
    database.close();

    assert.throws(
      () => openRuntimeCore(options),
      /authoritative current projection differs from its capsule/,
    );
  }));

test("restart validates capsule mutations against the original Act payload", () =>
  withAcceptedStorage(({ options, recoveryRoot }) => {
    const commitsDirectory = join(recoveryRoot, "commits");
    const [capsuleName] = readdirSync(commitsDirectory);
    const capsulePath = join(commitsDirectory, capsuleName);
    const capsule = JSON.parse(readFileSync(capsulePath, "utf8"));
    capsule.mutations.run.objective = "A different capsule objective";
    capsule.capsuleDigest = capsuleDigest(capsule);
    chmodSync(capsulePath, 0o600);
    writeFileSync(capsulePath, JSON.stringify(capsule));

    assert.throws(
      () => openRuntimeCore(options),
      /capsule mutations do not match the original request payload/,
    );
  }));

test("a later Act recovers one prepared revision before disposition", async () => {
  const root = mkdtempSync(join(tmpdir(), "openab-runtime-prepared-"));
  const primaryRoot = join(root, "primary");
  const recoveryRoot = join(root, "recovery");
  mkdirSync(primaryRoot);
  mkdirSync(recoveryRoot);
  let sequence = 0;
  const options = {
    ...runtimeCoreOptions(primaryRoot, recoveryRoot),
    identifiers: {
      offer: () => "offer:prepared-test",
      run: () => `run:prepared-${(sequence += 1)}`,
      commit: () => `commit:prepared-${sequence}`,
      effectIntent: () => `effect-intent:prepared-${sequence}`,
    },
  };
  const core = openRuntimeCore(options);

  try {
    const observed = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    const database = new DatabaseSync(
      join(primaryRoot, "runtime-core.sqlite3"),
    );
    database
      .prepare(
        `INSERT INTO runs
           (run_id, objective, stage, condition, review_round, outcome,
            created_at, created_revision)
         VALUES ('run:prepared-1', 'fault setup', 'Planning', 'Active',
                 NULL, NULL, '2026-08-13T00:00:00.000Z', 99)`,
      )
      .run();
    database.close();

    const preparedRequest = {
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:prepared-1",
      offer: observed.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Prepare the first capsule" },
      },
    };
    await assert.rejects(
      core.operator(preparedRequest),
      /UNIQUE constraint failed: runs.run_id/,
    );

    const repairDatabase = new DatabaseSync(
      join(primaryRoot, "runtime-core.sqlite3"),
    );
    repairDatabase
      .prepare("DELETE FROM runs WHERE created_revision = 99")
      .run();
    repairDatabase.close();

    const later = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:prepared-2",
      offer: observed.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Do not prepare another capsule" },
      },
    });
    assert.equal(later.status, "rejected");
    assert.equal(later.rejection.code, "StaleOffer");
    assert.deepEqual(later.cursor, {
      revision: 1,
      commitId: "commit:prepared-1",
    });
    assert.equal(readdirSync(join(recoveryRoot, "commits")).length, 1);

    const recovered = await core.operator(preparedRequest);
    assert.equal(recovered.status, "duplicate");
    assert.deepEqual(recovered.receipt, {
      status: "accepted",
      requestId: "request:prepared-1",
      commitId: "commit:prepared-1",
      revision: 1,
      actionKind: "SubmitObjective",
      runId: "run:prepared-1",
      acceptedAt: "2026-08-13T00:00:00.000Z",
    });
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent Acts serialize recovery and disposition", async () => {
  const root = mkdtempSync(join(tmpdir(), "openab-runtime-contenders-"));
  const primaryRoot = join(root, "primary");
  const recoveryRoot = join(root, "recovery");
  mkdirSync(primaryRoot);
  mkdirSync(recoveryRoot);
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const options = {
    ...runtimeCoreOptions(primaryRoot, recoveryRoot),
    identifiers: {
      offer: () => "offer:contended",
      run: () => {
        Atomics.store(signal, 0, 1);
        Atomics.notify(signal, 0);
        Atomics.wait(signal, 0, 1, 250);
        return "run:contender-b";
      },
      commit: () => "commit:contender-b",
      effectIntent: () => "effect-intent:contender-b",
    },
  };
  const core = openRuntimeCore(options);
  let worker;

  try {
    const observed = await core.operator({
      kind: "Observe",
      principal: OPERATOR_ID,
      locale: "en",
    });
    const database = new DatabaseSync(
      join(primaryRoot, "runtime-core.sqlite3"),
    );
    database
      .prepare(
        `INSERT INTO runs
           (run_id, objective, stage, condition, review_round, outcome,
            created_at, created_revision)
         VALUES ('run:contender-a', 'fault setup', 'Planning', 'Active',
                 NULL, NULL, '2026-08-13T00:00:00.000Z', 99)`,
      )
      .run();
    database.close();

    worker = new Worker(
      new URL("../test-support/runtime-core-contender.mjs", import.meta.url),
      {
        workerData: {
          primaryRoot,
          recoveryRoot,
          signal: signal.buffer,
          request: {
            kind: "Act",
            principal: OPERATOR_ID,
            locale: "en",
            requestId: "request:contender-a",
            offer: observed.offers[0].offer,
            action: {
              kind: "SubmitObjective",
              payload: { objective: "Objective from contender A" },
            },
          },
        },
      },
    );
    const ready = new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", resolve);
    });
    assert.deepEqual(await ready, { type: "ready" });
    const contenderResult = new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", resolve);
    });

    const accepted = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:contender-b",
      offer: observed.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Objective from contender B" },
      },
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.receipt.commitId, "commit:contender-b");

    const contender = await contenderResult;
    assert.equal(contender.type, "result");
    assert.equal(contender.reply.status, "rejected");
    assert.equal(contender.reply.rejection.code, "StaleOffer");
    assert.deepEqual(contender.reply.cursor, accepted.cursor);
    assert.equal(readdirSync(join(recoveryRoot, "commits")).length, 1);
  } finally {
    core.close();
    await worker?.terminate();
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "first recovery subdirectory creation syncs the recovery root",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "openab-recovery-layout-"));
    const primaryRoot = join(root, "primary");
    const recoveryRoot = join(root, "recovery");
    mkdirSync(primaryRoot);
    mkdirSync(recoveryRoot);
    chmodSync(recoveryRoot, 0o300);
    let core;

    try {
      assert.throws(
        () => {
          core = openRuntimeCore(
            runtimeCoreOptions(primaryRoot, recoveryRoot),
          );
        },
        (error) => error?.code === "EACCES",
      );
    } finally {
      core?.close();
      chmodSync(recoveryRoot, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
