import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
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

import { openRuntimeCore } from "../src/runtime-core.mjs";

const OPERATOR_ID = "operator:test";
const CONFIGURATION_DIGEST = `sha256:${"a".repeat(64)}`;

function runtimeCoreOptions(primaryRoot, recoveryRoot) {
  return {
    primaryRoot,
    recoveryRoot,
    operatorIdentity: OPERATOR_ID,
    configurationRevision: "configuration:test-1",
    effectiveConfigurationDigest: CONFIGURATION_DIGEST,
    clock: () => "2026-08-13T00:00:00.000Z",
    identifiers: {
      offer: () => "offer:test-1",
      run: () => "run:test-1",
      commit: () => "commit:test-1",
      effectIntent: () => "effect-intent:test-1",
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
        run: null,
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
    };
    assert.deepEqual(reply, {
      status: "accepted",
      receipt,
      cursor: { revision: 1, commitId: "commit:test-1" },
      view: {
        locale: "en",
        run,
        copy: {
          status: "Run is active in Planning",
          nextAction: "Await the Orchestrator Agent's Run Plan",
        },
      },
      offers: [],
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
        offers: [],
      },
    );
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
    assert.equal(duplicate.view.locale, "zh-TW");
    assert.deepEqual(duplicate.view.copy, {
      status: "Run 正在 Planning 階段進行",
      nextAction: "等待 Orchestrator Agent 提出 Run Plan",
    });
    assert.deepEqual(duplicate.offers, []);
  }));

test("conflicting request IDs and stale or mismatched offers do not commit", () =>
  withRuntimeCore(async ({ core }) => {
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

    const conflict = await core.operator({
      kind: "Act",
      principal: OPERATOR_ID,
      locale: "en",
      requestId: "request:test-1",
      offer: observed.offers[0].offer,
      action: {
        kind: "SubmitObjective",
        payload: { objective: "Different content" },
      },
    });
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
    assert.deepEqual(finalView.offers, []);
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
    assert.deepEqual(recovered.offers, []);
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
