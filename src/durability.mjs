import { randomUUID as durabilityRandomUUID } from "node:crypto";
import {
  chmodSync as durabilityChmodSync,
  closeSync as durabilityCloseSync,
  fsyncSync as durabilityFsyncSync,
  linkSync as durabilityLinkSync,
  mkdirSync as durabilityMkdirSync,
  openSync as durabilityOpenSync,
  readFileSync as durabilityReadFileSync,
  readdirSync as durabilityReaddirSync,
  unlinkSync as durabilityUnlinkSync,
  writeFileSync as durabilityWriteFileSync,
} from "node:fs";
import { join as durabilityJoin } from "node:path";
import { DatabaseSync as DurabilityDatabaseSync } from "node:sqlite";

import {
  canonicalDigest,
  canonicalJson,
  requireNonEmptyString,
} from "./canonical.mjs";

const DURABILITY_SCHEMA_VERSION = 1;
const DURABILITY_GENESIS_COMMIT_ID = "GENESIS";

function durabilitySyncPath(path) {
  const descriptor = durabilityOpenSync(path, "r");
  try {
    durabilityFsyncSync(descriptor);
  } finally {
    durabilityCloseSync(descriptor);
  }
}

function durabilityWriteImmutableJson(path, directory, value) {
  const temporaryPath = `${path}.tmp-${durabilityRandomUUID()}`;
  durabilityWriteFileSync(
    temporaryPath,
    `${canonicalJson(value)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  durabilitySyncPath(temporaryPath);
  try {
    durabilityLinkSync(temporaryPath, path);
    durabilityChmodSync(path, 0o400);
    durabilitySyncPath(directory);
  } finally {
    durabilityUnlinkSync(temporaryPath);
    durabilitySyncPath(directory);
  }
}

function durabilityOpenDatabase(primaryRoot) {
  durabilityMkdirSync(primaryRoot, { recursive: true });
  const database = new DurabilityDatabaseSync(
    durabilityJoin(primaryRoot, "runtime-core.sqlite3"),
  );
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA busy_timeout=5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS current_projection (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL,
      commit_id TEXT NOT NULL,
      run_json TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS operator_offers (
      offer TEXT PRIMARY KEY,
      principal TEXT NOT NULL,
      revision INTEGER NOT NULL,
      action_kind TEXT NOT NULL,
      constraints_json TEXT NOT NULL,
      consumed_revision INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      stage TEXT NOT NULL,
      condition TEXT NOT NULL,
      review_round TEXT,
      outcome TEXT,
      created_at TEXT NOT NULL,
      created_revision INTEGER NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS commit_identities (
      commit_id TEXT PRIMARY KEY,
      predecessor TEXT NOT NULL,
      revision INTEGER NOT NULL UNIQUE,
      authority_epoch INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      configuration_revision TEXT NOT NULL,
      configuration_digest TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      request_digest TEXT NOT NULL,
      capsule_digest TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS request_receipts (
      request_id TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      disposition TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      commit_id TEXT UNIQUE REFERENCES commit_identities(commit_id),
      receipt_capsule_digest TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS request_conflict_receipts (
      request_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      receipt_capsule_digest TEXT NOT NULL UNIQUE,
      PRIMARY KEY (request_id, request_digest)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS audit_records (
      revision INTEGER PRIMARY KEY,
      commit_id TEXT NOT NULL UNIQUE REFERENCES commit_identities(commit_id),
      transition_kind TEXT NOT NULL,
      record_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS effect_intents (
      effect_intent_id TEXT PRIMARY KEY,
      commit_id TEXT NOT NULL REFERENCES commit_identities(commit_id),
      effect_kind TEXT NOT NULL,
      disposition TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS immutable_commit_identities_update
      BEFORE UPDATE ON commit_identities BEGIN
        SELECT RAISE(ABORT, 'commit identities are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS immutable_commit_identities_delete
      BEFORE DELETE ON commit_identities BEGIN
        SELECT RAISE(ABORT, 'commit identities are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS immutable_request_receipts_update
      BEFORE UPDATE ON request_receipts BEGIN
        SELECT RAISE(ABORT, 'request receipts are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS immutable_request_receipts_delete
      BEFORE DELETE ON request_receipts BEGIN
        SELECT RAISE(ABORT, 'request receipts are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS immutable_request_conflicts_update
      BEFORE UPDATE ON request_conflict_receipts BEGIN
        SELECT RAISE(ABORT, 'request conflict receipts are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS immutable_request_conflicts_delete
      BEFORE DELETE ON request_conflict_receipts BEGIN
        SELECT RAISE(ABORT, 'request conflict receipts are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS immutable_audit_records_update
      BEFORE UPDATE ON audit_records BEGIN
        SELECT RAISE(ABORT, 'audit records are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS immutable_audit_records_delete
      BEFORE DELETE ON audit_records BEGIN
        SELECT RAISE(ABORT, 'audit records are immutable');
      END;
  `);
  return database;
}

function durabilityReadMetadata(database) {
  return Object.fromEntries(
    database.prepare("SELECT key, value FROM metadata").all().map((row) => [
      row.key,
      row.value,
    ]),
  );
}

function durabilityInitialize(database, options) {
  const metadata = durabilityReadMetadata(database);
  if (Object.keys(metadata).length === 0) {
    const insertMetadata = database.prepare(
      "INSERT INTO metadata (key, value) VALUES (?, ?)",
    );
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of Object.entries({
        schemaVersion: String(DURABILITY_SCHEMA_VERSION),
        authorityEpoch: "1",
        configurationRevision: options.configurationRevision,
        effectiveConfigurationDigest: options.effectiveConfigurationDigest,
        operatorIdentity: options.operatorIdentity,
      })) {
        insertMetadata.run(key, value);
      }
      database
        .prepare(
          `INSERT INTO current_projection
             (singleton, revision, commit_id, run_json)
           VALUES (1, 0, ?, NULL)`,
        )
        .run(DURABILITY_GENESIS_COMMIT_ID);
      const offer = options.initialOffer;
      database
        .prepare(
          `INSERT INTO operator_offers
             (offer, principal, revision, action_kind, constraints_json,
              consumed_revision)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          offer.offer,
          offer.principal,
          offer.revision,
          offer.actionKind,
          canonicalJson(offer.constraints),
          offer.consumedRevision,
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return;
  }

  const expected = {
    schemaVersion: String(DURABILITY_SCHEMA_VERSION),
    configurationRevision: options.configurationRevision,
    effectiveConfigurationDigest: options.effectiveConfigurationDigest,
    operatorIdentity: options.operatorIdentity,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== value) {
      throw new Error(`Runtime Core ${key} does not match its authoritative store`);
    }
  }
}

function durabilityReadState(database) {
  const projection = database
    .prepare(
      `SELECT revision, commit_id, run_json
       FROM current_projection WHERE singleton = 1`,
    )
    .get();
  if (projection === undefined) {
    throw new Error("authoritative current projection is missing");
  }
  const offers = database
    .prepare(
      `SELECT offer, principal, revision, action_kind, constraints_json,
              consumed_revision
       FROM operator_offers ORDER BY action_kind, offer`,
    )
    .all()
    .map((offer) => ({
      offer: offer.offer,
      principal: offer.principal,
      revision: offer.revision,
      actionKind: offer.action_kind,
      constraints: JSON.parse(offer.constraints_json),
      consumedRevision: offer.consumed_revision,
    }));
  const latestReceipt =
    projection.commit_id === DURABILITY_GENESIS_COMMIT_ID
      ? null
      : database
          .prepare(
            "SELECT receipt_json FROM request_receipts WHERE commit_id = ?",
          )
          .get(projection.commit_id);
  if (
    projection.commit_id !== DURABILITY_GENESIS_COMMIT_ID &&
    latestReceipt === undefined
  ) {
    throw new Error("authoritative current projection has no durable receipt");
  }
  return {
    cursor: {
      revision: projection.revision,
      commitId: projection.commit_id,
    },
    run:
      projection.run_json === null ? null : JSON.parse(projection.run_json),
    latestReceipt:
      latestReceipt === null ? null : JSON.parse(latestReceipt.receipt_json),
    offers,
  };
}

function durabilitySealCapsule(body) {
  return { ...body, capsuleDigest: canonicalDigest(body) };
}

function durabilityCanonicalRequestContent(content) {
  return {
    principal: content?.principal,
    offer: content?.offer,
    action: {
      kind: content?.action?.kind,
      payload: { objective: content?.action?.payload?.objective },
    },
  };
}

function durabilityVerifyCapsule(capsule) {
  const { capsuleDigest, ...body } = capsule;
  requireNonEmptyString(capsuleDigest, "capsuleDigest");
  if (canonicalDigest(body) !== capsuleDigest) {
    throw new Error("recovery capsule digest does not verify");
  }
  if (capsule.format !== "openab.commit-capsule/v1") {
    throw new Error("recovery capsule format is unsupported");
  }
  if (
    canonicalJson(capsule.request.content) !==
      canonicalJson(
        durabilityCanonicalRequestContent(capsule.request.content),
      ) ||
    canonicalDigest(capsule.request.content) !== capsule.request.digest ||
    capsule.request.content.offer !== capsule.mutations.consumedOffer ||
    capsule.request.content.principal !== capsule.audit.principal ||
    capsule.request.content.action?.kind !== capsule.audit.actionKind ||
    capsule.authorization?.principal !== capsule.audit.principal ||
    capsule.authorization?.actionKind !== capsule.audit.actionKind ||
    capsule.request.content.action?.payload?.objective !==
      capsule.mutations.run?.objective
  ) {
    throw new Error(
      "capsule mutations do not match the original request payload",
    );
  }
  if (
    capsule.receipt?.status !== "accepted" ||
    capsule.receipt.requestId !== capsule.request.id ||
    capsule.receipt.commitId !== capsule.commitId ||
    capsule.receipt.revision !== capsule.revision ||
    capsule.receipt.actionKind !== capsule.audit.actionKind ||
    capsule.receipt.runId !== capsule.mutations.run?.id
  ) {
    throw new Error("capsule receipt does not match its commit and mutations");
  }
}

function durabilityRecoveryLayout(recoveryRoot) {
  const commitsDirectory = durabilityJoin(recoveryRoot, "commits");
  const receiptsDirectory = durabilityJoin(recoveryRoot, "receipts");
  const commitsCreated = durabilityMkdirSync(commitsDirectory, {
    recursive: true,
  });
  const receiptsCreated = durabilityMkdirSync(receiptsDirectory, {
    recursive: true,
  });
  if (commitsCreated !== undefined || receiptsCreated !== undefined) {
    durabilitySyncPath(recoveryRoot);
  }
  return { commitsDirectory, receiptsDirectory };
}

function durabilityCapsulePath(layout, capsule) {
  const revision = String(capsule.revision).padStart(8, "0");
  return durabilityJoin(
    layout.commitsDirectory,
    `${revision}-${encodeURIComponent(capsule.commitId)}.json`,
  );
}

function durabilityReadCapsules(layout) {
  return durabilityReaddirSync(layout.commitsDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const capsule = JSON.parse(
        durabilityReadFileSync(
          durabilityJoin(layout.commitsDirectory, name),
          "utf8",
        ),
      );
      durabilityVerifyCapsule(capsule);
      return capsule;
    });
}

function durabilityReceiptCapsulePath(layout, capsule) {
  return durabilityJoin(
    layout.receiptsDirectory,
    `${encodeURIComponent(capsule.request.id)}-${capsule.request.digest.slice(-16)}.json`,
  );
}

function durabilityVerifyReceiptCapsule(capsule) {
  const { capsuleDigest, ...body } = capsule;
  requireNonEmptyString(capsuleDigest, "capsuleDigest");
  if (canonicalDigest(body) !== capsuleDigest) {
    throw new Error("recovery receipt capsule digest does not verify");
  }
  if (
    capsule.format !== "openab.rejection-receipt/v1" ||
    canonicalJson(capsule.request.content) !==
      canonicalJson(
        durabilityCanonicalRequestContent(capsule.request.content),
      ) ||
    canonicalDigest(capsule.request.content) !== capsule.request.digest ||
    capsule.receipt?.status !== "rejected" ||
    capsule.receipt.requestId !== capsule.request.id ||
    capsule.receipt.actionKind !== capsule.request.content.action?.kind ||
    canonicalJson(capsule.receipt.cursor) !== canonicalJson(capsule.cursor)
  ) {
    throw new Error("recovery rejection receipt capsule is inconsistent");
  }
  if (
    capsule.conflictWithDigest !== null &&
    (typeof capsule.conflictWithDigest !== "string" ||
      capsule.conflictWithDigest === capsule.request.digest)
  ) {
    throw new Error("recovery request conflict identity is inconsistent");
  }
}

function durabilityReadReceiptCapsules(layout) {
  return durabilityReaddirSync(layout.receiptsDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const capsule = JSON.parse(
        durabilityReadFileSync(
          durabilityJoin(layout.receiptsDirectory, name),
          "utf8",
        ),
      );
      durabilityVerifyReceiptCapsule(capsule);
      return capsule;
    })
    .sort(
      (left, right) =>
        Number(left.conflictWithDigest !== null) -
        Number(right.conflictWithDigest !== null),
    );
}

function durabilityVerifyReceiptCursor(database, cursor) {
  if (cursor.revision === 0 && cursor.commitId === DURABILITY_GENESIS_COMMIT_ID) {
    return;
  }
  const identity = database
    .prepare(
      "SELECT revision FROM commit_identities WHERE commit_id = ?",
    )
    .get(cursor.commitId);
  if (identity === undefined || identity.revision !== cursor.revision) {
    throw new Error("rejection receipt names an unknown authoritative cursor");
  }
}

function durabilityApplyReceiptCapsule(
  database,
  capsule,
  transactionOpen = false,
) {
  durabilityVerifyReceiptCapsule(capsule);
  const authoritativeRequest = database
    .prepare(
      `SELECT request_digest, disposition, receipt_json,
              receipt_capsule_digest
       FROM request_receipts WHERE request_id = ?`,
    )
    .get(capsule.request.id);
  const isConflict = capsule.conflictWithDigest !== null;
  if (isConflict) {
    if (
      authoritativeRequest === undefined ||
      authoritativeRequest.request_digest !== capsule.conflictWithDigest ||
      authoritativeRequest.request_digest === capsule.request.digest
    ) {
      throw new Error("request conflict receipt has no durable original request");
    }
    const existingConflict = database
      .prepare(
        `SELECT receipt_json, receipt_capsule_digest
         FROM request_conflict_receipts
         WHERE request_id = ? AND request_digest = ?`,
      )
      .get(capsule.request.id, capsule.request.digest);
    if (existingConflict !== undefined) {
      if (
        existingConflict.receipt_json !== canonicalJson(capsule.receipt) ||
        existingConflict.receipt_capsule_digest !== capsule.capsuleDigest
      ) {
        throw new Error("durable request conflict differs from its capsule");
      }
      return;
    }
  } else if (authoritativeRequest !== undefined) {
    if (
      authoritativeRequest.request_digest !== capsule.request.digest ||
      authoritativeRequest.disposition !== "rejected" ||
      authoritativeRequest.receipt_json !== canonicalJson(capsule.receipt) ||
      authoritativeRequest.receipt_capsule_digest !== capsule.capsuleDigest
    ) {
      throw new Error("durable rejection receipt differs from its capsule");
    }
    return;
  }
  const metadata = durabilityReadMetadata(database);
  if (
    Number(metadata.authorityEpoch) !== capsule.authorityEpoch ||
    Number(metadata.schemaVersion) !== capsule.schemaVersion ||
    metadata.configurationRevision !== capsule.configuration.revision ||
    metadata.effectiveConfigurationDigest !== capsule.configuration.digest
  ) {
    throw new Error("rejection receipt authority or configuration is stale");
  }
  durabilityVerifyReceiptCursor(database, capsule.cursor);

  if (!transactionOpen) {
    database.exec("BEGIN IMMEDIATE");
  }
  try {
    if (isConflict) {
      database
        .prepare(
          `INSERT INTO request_conflict_receipts
             (request_id, request_digest, receipt_json,
              receipt_capsule_digest)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          capsule.request.id,
          capsule.request.digest,
          canonicalJson(capsule.receipt),
          capsule.capsuleDigest,
        );
    } else {
      database
        .prepare(
          `INSERT INTO request_receipts
             (request_id, request_digest, disposition, receipt_json, commit_id,
              receipt_capsule_digest)
           VALUES (?, ?, 'rejected', ?, NULL, ?)`,
        )
        .run(
          capsule.request.id,
          capsule.request.digest,
          canonicalJson(capsule.receipt),
          capsule.capsuleDigest,
        );
    }
    if (!transactionOpen) {
      database.exec("COMMIT");
    }
  } catch (error) {
    if (!transactionOpen) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

function durabilityVerifyRejectionReceipt(
  database,
  capsules,
  requestId,
  requestDigest,
) {
  const authoritativeRequest = database
    .prepare(
      `SELECT request_digest, disposition, receipt_json,
              receipt_capsule_digest
       FROM request_receipts WHERE request_id = ?`,
    )
    .get(requestId);
  const capsule = capsules.find(
    (candidate) =>
      candidate.request.id === requestId &&
      candidate.request.digest === requestDigest,
  );
  if (capsule === undefined) {
    throw new Error("durable rejection receipt has no matching capsule");
  }
  const row =
    authoritativeRequest?.request_digest === requestDigest
      ? authoritativeRequest
      : database
          .prepare(
            `SELECT request_digest, 'rejected' AS disposition, receipt_json,
                    receipt_capsule_digest
             FROM request_conflict_receipts
             WHERE request_id = ? AND request_digest = ?`,
          )
          .get(requestId, requestDigest);
  if (
    row === undefined ||
    row.disposition !== "rejected" ||
    row.request_digest !== capsule.request.digest ||
    row.receipt_json !== canonicalJson(capsule.receipt) ||
    row.receipt_capsule_digest !== capsule.capsuleDigest
  ) {
    throw new Error("durable rejection receipt differs from its capsule");
  }
  durabilityVerifyReceiptCapsule(capsule);
  return capsule;
}

function durabilityApplyCapsule(database, capsule, transactionOpen = false) {
  durabilityVerifyCapsule(capsule);
  const existing = database
    .prepare(
      "SELECT capsule_digest FROM commit_identities WHERE commit_id = ?",
    )
    .get(capsule.commitId);
  if (existing !== undefined) {
    if (existing.capsule_digest !== capsule.capsuleDigest) {
      throw new Error("Commit ID does not match its recovery capsule");
    }
    return;
  }

  if (!transactionOpen) {
    database.exec("BEGIN IMMEDIATE");
  }
  try {
    const metadata = durabilityReadMetadata(database);
    const state = durabilityReadState(database);
    if (
      state.cursor.commitId !== capsule.predecessor ||
      state.cursor.revision + 1 !== capsule.revision
    ) {
      throw new Error("recovery capsule is not the authoritative next commit");
    }
    if (
      Number(metadata.authorityEpoch) !== capsule.authorityEpoch ||
      Number(metadata.schemaVersion) !== capsule.schemaVersion ||
      metadata.configurationRevision !== capsule.configuration.revision ||
      metadata.effectiveConfigurationDigest !== capsule.configuration.digest
    ) {
      throw new Error("recovery capsule authority or configuration is stale");
    }
    const offer = state.offers.find(
      (candidate) => candidate.offer === capsule.mutations.consumedOffer,
    );
    if (
      offer === undefined ||
      offer.principal !== capsule.audit.principal ||
      offer.revision !== state.cursor.revision ||
      offer.actionKind !== capsule.audit.actionKind ||
      canonicalDigest(offer.constraints) !==
        capsule.authorization.offerConstraintsDigest ||
      offer.consumedRevision !== null
    ) {
      throw new Error("recovery capsule no longer has its authoritative offer");
    }

    database
      .prepare(
        `INSERT INTO commit_identities
           (commit_id, predecessor, revision, authority_epoch, schema_version,
            configuration_revision, configuration_digest, request_id,
            request_digest, capsule_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        capsule.commitId,
        capsule.predecessor,
        capsule.revision,
        capsule.authorityEpoch,
        capsule.schemaVersion,
        capsule.configuration.revision,
        capsule.configuration.digest,
        capsule.request.id,
        capsule.request.digest,
        capsule.capsuleDigest,
      );
    const run = capsule.mutations.run;
    database
      .prepare(
        `INSERT INTO runs
           (run_id, objective, stage, condition, review_round, outcome,
            created_at, created_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.objective,
        run.stage,
        run.condition,
        run.reviewRound,
        run.outcome,
        run.createdAt,
        capsule.revision,
      );
    database
      .prepare(
        `INSERT INTO request_receipts
           (request_id, request_digest, disposition, receipt_json, commit_id,
            receipt_capsule_digest)
         VALUES (?, ?, 'accepted', ?, ?, ?)`,
      )
      .run(
        capsule.request.id,
        capsule.request.digest,
        canonicalJson(capsule.receipt),
        capsule.commitId,
        capsule.capsuleDigest,
      );
    database
      .prepare(
        `INSERT INTO audit_records
           (revision, commit_id, transition_kind, record_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        capsule.revision,
        capsule.commitId,
        capsule.audit.actionKind,
        canonicalJson(capsule.audit),
      );
    for (const effect of capsule.effectIntents) {
      database
        .prepare(
          `INSERT INTO effect_intents
             (effect_intent_id, commit_id, effect_kind, disposition)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          effect.id,
          capsule.commitId,
          effect.kind,
          effect.disposition,
        );
    }
    database
      .prepare(
        "UPDATE operator_offers SET consumed_revision = ? WHERE offer = ?",
      )
      .run(capsule.revision, capsule.mutations.consumedOffer);
    database
      .prepare(
        `UPDATE current_projection
         SET revision = ?, commit_id = ?, run_json = ?
         WHERE singleton = 1`,
      )
      .run(
        capsule.revision,
        capsule.commitId,
        canonicalJson(run),
      );
    if (!transactionOpen) {
      database.exec("COMMIT");
    }
  } catch (error) {
    if (!transactionOpen) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

function durabilityVerifyCommit(database, capsules, commitId) {
  const identity = database
    .prepare(
      `SELECT predecessor, revision, authority_epoch, schema_version,
              configuration_revision, configuration_digest, request_id,
              request_digest, capsule_digest
       FROM commit_identities WHERE commit_id = ?`,
    )
    .get(commitId);
  if (identity === undefined) {
    throw new Error("authoritative commit identity is missing");
  }
  const capsule = capsules.find((candidate) => candidate.commitId === commitId);
  if (capsule === undefined) {
    throw new Error("authoritative commit has no matching recovery capsule");
  }
  durabilityVerifyCapsule(capsule);
  const expectedIdentity = {
    predecessor: capsule.predecessor,
    revision: capsule.revision,
    authority_epoch: capsule.authorityEpoch,
    schema_version: capsule.schemaVersion,
    configuration_revision: capsule.configuration.revision,
    configuration_digest: capsule.configuration.digest,
    request_id: capsule.request.id,
    request_digest: capsule.request.digest,
    capsule_digest: capsule.capsuleDigest,
  };
  if (
    canonicalJson({ ...identity }) !== canonicalJson(expectedIdentity)
  ) {
    throw new Error("authoritative commit identity differs from its capsule");
  }
  const receipt = database
    .prepare(
      `SELECT request_digest, disposition, receipt_json, commit_id,
              receipt_capsule_digest
       FROM request_receipts WHERE request_id = ?`,
    )
    .get(capsule.request.id);
  if (
    receipt === undefined ||
    receipt.request_digest !== capsule.request.digest ||
    receipt.disposition !== "accepted" ||
    receipt.receipt_json !== canonicalJson(capsule.receipt) ||
    receipt.commit_id !== capsule.commitId ||
    receipt.receipt_capsule_digest !== capsule.capsuleDigest
  ) {
    throw new Error("authoritative request receipt differs from its capsule");
  }
  const audit = database
    .prepare(
      `SELECT transition_kind, record_json, commit_id
       FROM audit_records WHERE revision = ?`,
    )
    .get(capsule.revision);
  if (
    audit === undefined ||
    audit.transition_kind !== capsule.audit.actionKind ||
    audit.record_json !== canonicalJson(capsule.audit) ||
    audit.commit_id !== capsule.commitId
  ) {
    throw new Error("authoritative audit record differs from its capsule");
  }
  const effects = database
    .prepare(
      `SELECT effect_intent_id AS id, effect_kind AS kind, disposition
       FROM effect_intents WHERE commit_id = ? ORDER BY effect_intent_id`,
    )
    .all(capsule.commitId);
  if (
    canonicalJson(effects) !==
    canonicalJson(
      [...capsule.effectIntents].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    )
  ) {
    throw new Error("authoritative Effect Intents differ from their capsule");
  }
  const runRow = database
    .prepare(
      `SELECT run_id, objective, stage, condition, review_round, outcome,
              created_at, created_revision
       FROM runs WHERE run_id = ?`,
    )
    .get(capsule.mutations.run.id);
  const expectedRunRow = {
    run_id: capsule.mutations.run.id,
    objective: capsule.mutations.run.objective,
    stage: capsule.mutations.run.stage,
    condition: capsule.mutations.run.condition,
    review_round: capsule.mutations.run.reviewRound,
    outcome: capsule.mutations.run.outcome,
    created_at: capsule.mutations.run.createdAt,
    created_revision: capsule.revision,
  };
  if (
    runRow === undefined ||
    canonicalJson({ ...runRow }) !== canonicalJson(expectedRunRow)
  ) {
    throw new Error("authoritative Run projection differs from its capsule");
  }
  const state = durabilityReadState(database);
  if (state.cursor.commitId === capsule.commitId) {
    const consumedOffer = state.offers.find(
      (offer) => offer.offer === capsule.mutations.consumedOffer,
    );
    if (
      state.cursor.revision !== capsule.revision ||
      canonicalJson(state.run) !== canonicalJson(capsule.mutations.run) ||
      canonicalJson(state.latestReceipt) !== canonicalJson(capsule.receipt)
    ) {
      throw new Error(
        "authoritative current projection differs from its capsule",
      );
    }
    if (
      consumedOffer === undefined ||
      consumedOffer.consumedRevision !== capsule.revision ||
      consumedOffer.principal !== capsule.request.content.principal ||
      consumedOffer.actionKind !== capsule.request.content.action.kind ||
      canonicalDigest(consumedOffer.constraints) !==
        capsule.authorization.offerConstraintsDigest
    ) {
      throw new Error("authoritative offer state differs from its capsule");
    }
  }
  return capsule;
}

function durabilityRecoverAndVerify(database, layout) {
  const { capsules, prepared } = durabilityPreparedCapsules(database, layout);
  if (prepared.length > 1) {
    throw new Error("multiple prepared recovery capsules require recovery");
  }
  if (prepared.length === 1) {
    durabilityApplyCapsule(database, prepared[0]);
  }

  const state = durabilityReadState(database);
  if (state.cursor.revision === 0) {
    if (state.cursor.commitId !== DURABILITY_GENESIS_COMMIT_ID) {
      throw new Error("genesis projection has an invalid commit identity");
    }
  } else {
    durabilityVerifyCommit(database, capsules, state.cursor.commitId);
  }
  durabilityRecoverReceiptCapsules(database, layout);
}

function durabilityRecoverReceiptCapsules(database, layout) {
  const receiptCapsules = durabilityReadReceiptCapsules(layout);
  for (const capsule of receiptCapsules) {
    durabilityApplyReceiptCapsule(database, capsule);
  }
  const rejectedRequests = database
    .prepare(
      `SELECT request_id, request_digest
       FROM request_receipts WHERE disposition = 'rejected'
       UNION ALL
       SELECT request_id, request_digest FROM request_conflict_receipts`,
    )
    .all();
  for (const row of rejectedRequests) {
    durabilityVerifyRejectionReceipt(
      database,
      receiptCapsules,
      row.request_id,
      row.request_digest,
    );
  }
  return receiptCapsules;
}

function durabilityBuildCapsule(database, candidate) {
  const metadata = durabilityReadMetadata(database);
  return durabilitySealCapsule({
    format: "openab.commit-capsule/v1",
    commitId: candidate.commitId,
    predecessor: candidate.predecessor,
    revision: candidate.revision,
    authorityEpoch: Number(metadata.authorityEpoch),
    schemaVersion: Number(metadata.schemaVersion),
    configuration: {
      revision: metadata.configurationRevision,
      digest: metadata.effectiveConfigurationDigest,
    },
    request: {
      id: candidate.requestId,
      digest: candidate.requestDigest,
      content: candidate.requestContent,
    },
    receipt: candidate.receipt,
    mutations: {
      run: candidate.run,
      consumedOffer: candidate.consumedOffer,
    },
    authorization: {
      principal: candidate.requestContent.principal,
      actionKind: candidate.requestContent.action.kind,
      offerConstraintsDigest: candidate.offerConstraintsDigest,
    },
    audit: candidate.audit,
    effectIntents: candidate.effectIntents,
  });
}

function durabilityBuildReceiptCapsule(database, candidate) {
  const metadata = durabilityReadMetadata(database);
  return durabilitySealCapsule({
    format: "openab.rejection-receipt/v1",
    authorityEpoch: Number(metadata.authorityEpoch),
    schemaVersion: Number(metadata.schemaVersion),
    configuration: {
      revision: metadata.configurationRevision,
      digest: metadata.effectiveConfigurationDigest,
    },
    cursor: candidate.receipt.cursor,
    request: {
      id: candidate.requestId,
      digest: candidate.requestDigest,
      content: candidate.requestContent,
    },
    conflictWithDigest: candidate.conflictWithDigest ?? null,
    receipt: candidate.receipt,
  });
}

function durabilityPreparedCapsules(database, layout) {
  const capsules = durabilityReadCapsules(layout);
  const committed = new Set(
    database
      .prepare("SELECT commit_id FROM commit_identities")
      .all()
      .map((row) => row.commit_id),
  );
  return {
    capsules,
    prepared: capsules.filter(
      (capsule) => !committed.has(capsule.commitId),
    ),
  };
}

function durabilityCommitCandidate(database, layout, candidate) {
  let capsule;
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database
      .prepare(
        `SELECT request_digest, disposition, receipt_json, commit_id
         FROM request_receipts WHERE request_id = ?`,
      )
      .get(candidate.requestId);
    if (existing !== undefined) {
      if (
        existing.request_digest !== candidate.requestDigest ||
        existing.disposition !== "accepted"
      ) {
        throw new Error("request identity already has another final disposition");
      }
      capsule = durabilityReadCapsules(layout).find(
        (item) => item.commitId === existing.commit_id,
      );
      if (capsule === undefined) {
        throw new Error("accepted request has no recovery capsule");
      }
    } else {
      const { prepared } = durabilityPreparedCapsules(database, layout);
      if (prepared.length > 1) {
        throw new Error("multiple prepared recovery capsules require recovery");
      }
      if (prepared.length === 1) {
        [capsule] = prepared;
        if (
          capsule.request.id !== candidate.requestId ||
          capsule.request.digest !== candidate.requestDigest
        ) {
          throw new Error(
            "prepared recovery capsule must be completed before another request",
          );
        }
      } else {
        const state = durabilityReadState(database);
        if (
          candidate.predecessor !== state.cursor.commitId ||
          candidate.revision !== state.cursor.revision + 1
        ) {
          throw new Error("CommitCandidate is stale");
        }
        capsule = durabilityBuildCapsule(database, candidate);
        durabilityWriteImmutableJson(
          durabilityCapsulePath(layout, capsule),
          layout.commitsDirectory,
          capsule,
        );
      }
      durabilityApplyCapsule(database, capsule, true);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  durabilityVerifyCommit(
    database,
    durabilityReadCapsules(layout),
    capsule.commitId,
  );
  return structuredClone(capsule.receipt);
}

function durabilityRecordRejection(database, layout, candidate) {
  let capsule;
  database.exec("BEGIN IMMEDIATE");
  try {
    const { prepared } = durabilityPreparedCapsules(database, layout);
    if (prepared.length > 0) {
      throw new Error(
        "prepared recovery capsule must be completed before another request",
      );
    }
    const authoritativeRequest = database
      .prepare(
        `SELECT request_digest, disposition
         FROM request_receipts WHERE request_id = ?`,
      )
      .get(candidate.requestId);
    const isConflict = candidate.conflictWithDigest !== undefined;
    const existingAuthoritative =
      !isConflict &&
      authoritativeRequest?.request_digest === candidate.requestDigest &&
      authoritativeRequest.disposition === "rejected";
    if (
      (!isConflict &&
        authoritativeRequest !== undefined &&
        !existingAuthoritative) ||
      (isConflict &&
        authoritativeRequest?.request_digest !== candidate.conflictWithDigest)
    ) {
      throw new Error("request identity already has another final disposition");
    }
    const existingConflict = isConflict
      ? database
          .prepare(
            `SELECT 1 FROM request_conflict_receipts
             WHERE request_id = ? AND request_digest = ?`,
          )
          .get(candidate.requestId, candidate.requestDigest)
      : undefined;
    const receiptCapsules = durabilityReadReceiptCapsules(layout);
    capsule = receiptCapsules.find(
      (item) =>
        item.request.id === candidate.requestId &&
        item.request.digest === candidate.requestDigest,
    );
    if (existingAuthoritative || existingConflict !== undefined) {
      if (capsule === undefined) {
        throw new Error("request conflict has no recovery receipt capsule");
      }
    } else {
      if (capsule !== undefined) {
        if (
          capsule.conflictWithDigest !==
          (candidate.conflictWithDigest ?? null)
        ) {
          throw new Error("request rejection capsule has another disposition");
        }
      } else {
        const state = durabilityReadState(database);
        if (
          canonicalJson(state.cursor) !== canonicalJson(candidate.receipt.cursor)
        ) {
          throw new Error("rejection receipt cursor is stale");
        }
        capsule = durabilityBuildReceiptCapsule(database, candidate);
        durabilityWriteImmutableJson(
          durabilityReceiptCapsulePath(layout, capsule),
          layout.receiptsDirectory,
          capsule,
        );
      }
      durabilityApplyReceiptCapsule(database, capsule, true);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  durabilityVerifyRejectionReceipt(
    database,
    durabilityReadReceiptCapsules(layout),
    candidate.requestId,
    candidate.requestDigest,
  );
  return structuredClone(capsule.receipt);
}

export function openDurability(options) {
  for (const field of [
    "primaryRoot",
    "recoveryRoot",
    "operatorIdentity",
    "configurationRevision",
    "effectiveConfigurationDigest",
  ]) {
    requireNonEmptyString(options?.[field], field);
  }
  const layout = durabilityRecoveryLayout(options.recoveryRoot);
  const database = durabilityOpenDatabase(options.primaryRoot);
  try {
    durabilityInitialize(database, options);
    durabilityRecoverAndVerify(database, layout);
  } catch (error) {
    database.close();
    throw error;
  }

  return {
    recover() {
      durabilityRecoverAndVerify(database, layout);
    },

    inspect() {
      return durabilityReadState(database);
    },

    receipt(requestId, requestDigest) {
      durabilityRecoverReceiptCapsules(database, layout);
      const row = database
        .prepare(
          `SELECT request_digest, disposition, receipt_json, commit_id
           FROM request_receipts WHERE request_id = ?`,
        )
        .get(requestId);
      if (row === undefined) {
        return null;
      }
      if (row.request_digest !== requestDigest) {
        const conflict = database
          .prepare(
            `SELECT request_digest, receipt_json
             FROM request_conflict_receipts
             WHERE request_id = ? AND request_digest = ?`,
          )
          .get(requestId, requestDigest);
        if (conflict === undefined) {
          return {
            conflictWithDigest: row.request_digest,
            priorReceipt: JSON.parse(row.receipt_json),
          };
        }
        durabilityVerifyRejectionReceipt(
          database,
          durabilityReadReceiptCapsules(layout),
          requestId,
          requestDigest,
        );
        return {
          requestDigest: conflict.request_digest,
          receipt: JSON.parse(conflict.receipt_json),
        };
      }
      if (row.disposition === "accepted") {
        durabilityVerifyCommit(
          database,
          durabilityReadCapsules(layout),
          row.commit_id,
        );
      } else if (row.disposition === "rejected") {
        durabilityVerifyRejectionReceipt(
          database,
          durabilityReadReceiptCapsules(layout),
          requestId,
          requestDigest,
        );
      } else {
        throw new Error("request receipt has an unknown disposition");
      }
      return {
        requestDigest: row.request_digest,
        receipt: JSON.parse(row.receipt_json),
      };
    },

    commit(candidate) {
      return durabilityCommitCandidate(database, layout, candidate);
    },

    reject(candidate) {
      return durabilityRecordRejection(database, layout, candidate);
    },

    close() {
      database.close();
    },
  };
}
