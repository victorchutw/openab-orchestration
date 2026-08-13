import { createHash as durabilityCreateHash, randomUUID as durabilityRandomUUID } from "node:crypto";
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

const DURABILITY_SCHEMA_VERSION = 1;
const DURABILITY_GENESIS_COMMIT_ID = "GENESIS";

function durabilityRequireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function durabilityCanonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(durabilityCanonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, durabilityCanonicalize(value[key])]),
    );
  }
  return value;
}

function durabilityCanonicalJson(value) {
  return JSON.stringify(durabilityCanonicalize(value));
}

function durabilityDigest(value) {
  return `sha256:${durabilityCreateHash("sha256")
    .update(
      typeof value === "string" ? value : durabilityCanonicalJson(value),
    )
    .digest("hex")}`;
}

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
    `${durabilityCanonicalJson(value)}\n`,
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
      receipt_json TEXT NOT NULL,
      commit_id TEXT NOT NULL UNIQUE REFERENCES commit_identities(commit_id)
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
          durabilityCanonicalJson(offer.constraints),
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
  return {
    cursor: {
      revision: projection.revision,
      commitId: projection.commit_id,
    },
    run:
      projection.run_json === null ? null : JSON.parse(projection.run_json),
    offers,
  };
}

function durabilitySealCapsule(body) {
  return { ...body, capsuleDigest: durabilityDigest(body) };
}

function durabilityVerifyCapsule(capsule) {
  const { capsuleDigest, ...body } = capsule;
  durabilityRequireNonEmptyString(capsuleDigest, "capsuleDigest");
  if (durabilityDigest(body) !== capsuleDigest) {
    throw new Error("recovery capsule digest does not verify");
  }
}

function durabilityRecoveryLayout(recoveryRoot) {
  const commitsDirectory = durabilityJoin(recoveryRoot, "commits");
  durabilityMkdirSync(commitsDirectory, { recursive: true });
  return { commitsDirectory };
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

function durabilityApplyCapsule(database, capsule) {
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

  database.exec("BEGIN IMMEDIATE");
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
           (request_id, request_digest, receipt_json, commit_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        capsule.request.id,
        capsule.request.digest,
        durabilityCanonicalJson(capsule.receipt),
        capsule.commitId,
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
        durabilityCanonicalJson(capsule.audit),
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
        durabilityCanonicalJson(run),
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
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
    durabilityCanonicalJson({ ...identity }) !==
    durabilityCanonicalJson(expectedIdentity)
  ) {
    throw new Error("authoritative commit identity differs from its capsule");
  }
  const receipt = database
    .prepare(
      `SELECT request_digest, receipt_json, commit_id
       FROM request_receipts WHERE request_id = ?`,
    )
    .get(capsule.request.id);
  if (
    receipt === undefined ||
    receipt.request_digest !== capsule.request.digest ||
    receipt.receipt_json !== durabilityCanonicalJson(capsule.receipt) ||
    receipt.commit_id !== capsule.commitId
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
    audit.record_json !== durabilityCanonicalJson(capsule.audit) ||
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
    durabilityCanonicalJson(effects) !==
    durabilityCanonicalJson(
      [...capsule.effectIntents].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    )
  ) {
    throw new Error("authoritative Effect Intents differ from their capsule");
  }
  return capsule;
}

function durabilityRecoverAndVerify(database, layout) {
  const capsules = durabilityReadCapsules(layout);
  const committed = new Set(
    database
      .prepare("SELECT commit_id FROM commit_identities")
      .all()
      .map((row) => row.commit_id),
  );
  const prepared = capsules.filter(
    (capsule) => !committed.has(capsule.commitId),
  );
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
    },
    receipt: candidate.receipt,
    mutations: {
      run: candidate.run,
      consumedOffer: candidate.consumedOffer,
    },
    audit: candidate.audit,
    effectIntents: candidate.effectIntents,
  });
}

export function openDurability(options) {
  for (const field of [
    "primaryRoot",
    "recoveryRoot",
    "operatorIdentity",
    "configurationRevision",
    "effectiveConfigurationDigest",
  ]) {
    durabilityRequireNonEmptyString(options?.[field], field);
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
    inspect() {
      return durabilityReadState(database);
    },

    receipt(requestId) {
      const row = database
        .prepare(
          `SELECT request_digest, receipt_json, commit_id
           FROM request_receipts WHERE request_id = ?`,
        )
        .get(requestId);
      if (row === undefined) {
        return null;
      }
      durabilityVerifyCommit(
        database,
        durabilityReadCapsules(layout),
        row.commit_id,
      );
      return {
        requestDigest: row.request_digest,
        receipt: JSON.parse(row.receipt_json),
      };
    },

    commit(candidate) {
      const capsule = durabilityBuildCapsule(database, candidate);
      durabilityWriteImmutableJson(
        durabilityCapsulePath(layout, capsule),
        layout.commitsDirectory,
        capsule,
      );
      durabilityApplyCapsule(database, capsule);
      durabilityVerifyCommit(
        database,
        durabilityReadCapsules(layout),
        capsule.commitId,
      );
      return structuredClone(capsule.receipt);
    },

    close() {
      database.close();
    },
  };
}
