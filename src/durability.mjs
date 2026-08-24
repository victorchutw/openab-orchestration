import {
  createHash as durabilityCreateHash,
  randomUUID as durabilityRandomUUID,
} from "node:crypto";
import {
  chmodSync as durabilityChmodSync,
  closeSync as durabilityCloseSync,
  copyFileSync as durabilityCopyFileSync,
  existsSync as durabilityExistsSync,
  fsyncSync as durabilityFsyncSync,
  linkSync as durabilityLinkSync,
  mkdirSync as durabilityMkdirSync,
  openSync as durabilityOpenSync,
  readFileSync as durabilityReadFileSync,
  readdirSync as durabilityReaddirSync,
  renameSync as durabilityRenameSync,
  rmSync as durabilityRmSync,
  statSync as durabilityStatSync,
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

function durabilityDatabasePath(primaryRoot) {
  return durabilityJoin(primaryRoot, "runtime-core.sqlite3");
}

function durabilityDigestBytes(value) {
  return `sha256:${durabilityCreateHash("sha256").update(value).digest("hex")}`;
}

function durabilityObjectPath(root, digest) {
  const value = digest.slice("sha256:".length);
  return durabilityJoin(root, "objects", "sha256", value.slice(0, 2), value.slice(2));
}

function durabilityNormalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) {
    throw new TypeError("CommitCandidate artifacts must be an array");
  }
  const seen = new Set();
  return artifacts.map((artifact) => {
    requireNonEmptyString(artifact?.digest, "artifact.digest");
    if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) {
      throw new TypeError("artifact.digest must be a lowercase SHA-256 digest");
    }
    if (seen.has(artifact.digest)) {
      throw new Error("CommitCandidate contains a duplicate artifact digest");
    }
    seen.add(artifact.digest);
    if (!ArrayBuffer.isView(artifact.bytes)) {
      throw new TypeError("artifact.bytes must be a byte array");
    }
    const bytes = Buffer.from(
      artifact.bytes.buffer,
      artifact.bytes.byteOffset,
      artifact.bytes.byteLength,
    );
    if (
      artifact.size !== bytes.byteLength ||
      artifact.digest !== durabilityDigestBytes(bytes)
    ) {
      throw new Error("artifact bytes do not match their size and digest");
    }
    return { digest: artifact.digest, size: artifact.size, bytes };
  });
}

function durabilityVerifyObject(root, artifact) {
  const path = durabilityObjectPath(root, artifact.digest);
  if (!durabilityExistsSync(path)) {
    throw new Error(`content-addressed artifact is missing: ${artifact.digest}`);
  }
  const bytes = durabilityReadFileSync(path);
  if (
    bytes.byteLength !== artifact.size ||
    durabilityDigestBytes(bytes) !== artifact.digest
  ) {
    throw new Error(`content-addressed artifact does not verify: ${artifact.digest}`);
  }
  return bytes;
}

function durabilityPromoteObject(root, artifact) {
  const path = durabilityObjectPath(root, artifact.digest);
  if (durabilityExistsSync(path)) {
    durabilityVerifyObject(root, artifact);
    return;
  }
  const directory = durabilityJoin(
    root,
    "objects",
    "sha256",
    artifact.digest.slice(7, 9),
  );
  durabilityMkdirSync(directory, { recursive: true });
  const temporaryPath = durabilityJoin(
    directory,
    `.tmp-${durabilityRandomUUID()}`,
  );
  durabilityWriteFileSync(temporaryPath, artifact.bytes, {
    flag: "wx",
    mode: 0o600,
  });
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

function durabilityRequireSecretReferenceGenerations(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("secretReferenceGenerations must be an object");
  }
  for (const [purpose, generation] of Object.entries(value)) {
    requireNonEmptyString(purpose, "secretReferenceGenerations purpose");
    requireNonEmptyString(
      generation,
      `secretReferenceGenerations.${purpose}`,
    );
  }
  return canonicalJson(value);
}

function durabilityMetadataConfigurationIdentity(metadata) {
  return {
    revision: metadata.configurationRevision,
    digest: metadata.effectiveConfigurationDigest,
    secretReferenceGenerations: JSON.parse(
      metadata.secretReferenceGenerations,
    ),
  };
}

function durabilityOptionsConfigurationIdentity(options) {
  return {
    revision: options.configurationRevision,
    digest: options.effectiveConfigurationDigest,
    secretReferenceGenerations: structuredClone(
      options.secretReferenceGenerations,
    ),
  };
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
    durabilityDatabasePath(primaryRoot),
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
      authority_epoch INTEGER NOT NULL,
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
    CREATE TABLE IF NOT EXISTS artifacts (
      digest TEXT PRIMARY KEY,
      size INTEGER NOT NULL CHECK (size >= 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS artifact_relationships (
      commit_id TEXT NOT NULL REFERENCES commit_identities(commit_id),
      artifact_digest TEXT NOT NULL REFERENCES artifacts(digest),
      PRIMARY KEY (commit_id, artifact_digest)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS recovery_activations (
      request_id TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      source_recovery_point TEXT NOT NULL,
      source_manifest_digest TEXT NOT NULL,
      restored_at TEXT NOT NULL,
      authority_epoch INTEGER NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS recovery_effects (
      effect_intent_id TEXT NOT NULL REFERENCES effect_intents(effect_intent_id),
      authority_epoch INTEGER NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (effect_intent_id, authority_epoch)
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
    CREATE TRIGGER IF NOT EXISTS immutable_recovery_activations_update
      BEFORE UPDATE ON recovery_activations BEGIN
        SELECT RAISE(ABORT, 'recovery activations are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS immutable_recovery_activations_delete
      BEFORE DELETE ON recovery_activations BEGIN
        SELECT RAISE(ABORT, 'recovery activations are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS immutable_artifact_relationships_update
      BEFORE UPDATE ON artifact_relationships BEGIN
        SELECT RAISE(ABORT, 'artifact relationships are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS immutable_artifact_relationships_delete
      BEFORE DELETE ON artifact_relationships BEGIN
        SELECT RAISE(ABORT, 'artifact relationships are immutable');
      END;
  `);
  return database;
}

function durabilityUseWriterTransaction(
  database,
  transactionOpen,
  operation,
) {
  if (transactionOpen) {
    return operation();
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
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
        secretReferenceGenerations: durabilityRequireSecretReferenceGenerations(
          options.secretReferenceGenerations,
        ),
        operatorIdentity: options.operatorIdentity,
        recoveryGate: "open",
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
             (offer, principal, revision, authority_epoch, action_kind, constraints_json,
              consumed_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          offer.offer,
          offer.principal,
          offer.revision,
          offer.authorityEpoch,
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
    secretReferenceGenerations: durabilityRequireSecretReferenceGenerations(
      options.secretReferenceGenerations,
    ),
    operatorIdentity: options.operatorIdentity,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== value) {
      throw new Error(`Runtime Core ${key} does not match its authoritative store`);
    }
  }
}

function durabilityReadState(database) {
  const metadata = durabilityReadMetadata(database);
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
      `SELECT offer, principal, revision, authority_epoch, action_kind, constraints_json,
              consumed_revision
       FROM operator_offers ORDER BY action_kind, offer`,
    )
    .all()
    .map((offer) => ({
      offer: offer.offer,
      principal: offer.principal,
      revision: offer.revision,
      authorityEpoch: offer.authority_epoch,
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
  const activation = database
    .prepare(
      `SELECT source_recovery_point, authority_epoch
       FROM recovery_activations ORDER BY authority_epoch DESC LIMIT 1`,
    )
    .get();
  const pendingEffectIntentIds = database
    .prepare(
      `SELECT effect_intent_id FROM recovery_effects
       WHERE status = 'Pending' AND authority_epoch = ?
       ORDER BY effect_intent_id`,
    )
    .all(Number(metadata.authorityEpoch))
    .map((row) => row.effect_intent_id);
  const authorityEpoch = Number(metadata.authorityEpoch);
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
    authorityEpoch,
    recovery:
      metadata.recoveryGate === "reconciliation"
        ? {
            status: "Reconciliation",
            condition: "Active",
            authorityEpoch,
            sourceRecoveryPoint: activation?.source_recovery_point,
            pendingEffectIntentIds,
          }
        : null,
  };
}

function durabilityReadReferencedArtifacts(database) {
  return database
    .prepare(
      `SELECT DISTINCT a.digest, a.size
       FROM artifact_relationships ar
       JOIN artifacts a ON a.digest = ar.artifact_digest
       ORDER BY a.digest`,
    )
    .all();
}

function durabilitySealCapsule(body) {
  return { ...body, capsuleDigest: canonicalDigest(body) };
}

function durabilityCanonicalRequestContent(content) {
  const payload =
    content?.action?.kind === "Restore"
      ? { recoveryPoint: content?.action?.payload?.recoveryPoint }
      : { objective: content?.action?.payload?.objective };
  return {
    principal: content?.principal,
    offer: content?.offer,
    action: {
      kind: content?.action?.kind,
      payload,
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
  durabilityRequireSecretReferenceGenerations(
    capsule.configuration?.secretReferenceGenerations,
  );
  if (!Array.isArray(capsule.artifacts)) {
    throw new Error("recovery capsule artifacts are invalid");
  }
  const artifactDigests = new Set();
  for (const artifact of capsule.artifacts) {
    if (
      !/^sha256:[a-f0-9]{64}$/.test(artifact?.digest) ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0 ||
      artifactDigests.has(artifact.digest)
    ) {
      throw new Error("recovery capsule artifact identity is invalid");
    }
    artifactDigests.add(artifact.digest);
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

function durabilityRecoveryLayout(recoveryRoot, primaryRoot) {
  const commitsDirectory = durabilityJoin(recoveryRoot, "commits");
  const receiptsDirectory = durabilityJoin(recoveryRoot, "receipts");
  const generationsDirectory = durabilityJoin(recoveryRoot, "generations");
  const commitsCreated = durabilityMkdirSync(commitsDirectory, {
    recursive: true,
  });
  const receiptsCreated = durabilityMkdirSync(receiptsDirectory, {
    recursive: true,
  });
  const generationsCreated = durabilityMkdirSync(generationsDirectory, {
    recursive: true,
  });
  if (
    commitsCreated !== undefined ||
    receiptsCreated !== undefined ||
    generationsCreated !== undefined
  ) {
    durabilitySyncPath(recoveryRoot);
  }
  return {
    commitsDirectory,
    receiptsDirectory,
    generationsDirectory,
    primaryRoot,
    recoveryRoot,
  };
}

function durabilitySealGeneration(body) {
  return { ...body, manifestDigest: canonicalDigest(body) };
}

function durabilityGenerationDirectoryName(manifest) {
  const revision = String(manifest.cursor.revision).padStart(8, "0");
  return `${revision}-e${manifest.authorityEpoch}-${manifest.manifestDigest.slice(-16)}`;
}

function durabilityVerifyGenerationManifest(manifest) {
  const { manifestDigest, ...body } = manifest;
  requireNonEmptyString(manifestDigest, "manifestDigest");
  if (canonicalDigest(body) !== manifestDigest) {
    throw new Error("recovery generation manifest digest does not verify");
  }
  if (manifest.format !== "openab.recovery-generation/v1") {
    throw new Error("recovery generation format is unsupported");
  }
  durabilityRequireSecretReferenceGenerations(
    manifest.configuration?.secretReferenceGenerations,
  );
}

function durabilityCreateGeneration(database, layout) {
  const state = durabilityReadState(database);
  const metadata = durabilityReadMetadata(database);
  const referencedArtifacts = durabilityReadReferencedArtifacts(database);
  const temporaryDirectory = durabilityJoin(
    layout.generationsDirectory,
    `.tmp-${durabilityRandomUUID()}`,
  );
  durabilityMkdirSync(temporaryDirectory);
  const databasePath = durabilityJoin(
    temporaryDirectory,
    "runtime-core.sqlite3",
  );
  try {
    const quotedPath = databasePath.replaceAll("'", "''");
    database.exec(`VACUUM main INTO '${quotedPath}'`);
    durabilitySyncPath(databasePath);
    const databaseBytes = durabilityReadFileSync(databasePath);
    const manifest = durabilitySealGeneration({
      format: "openab.recovery-generation/v1",
      cursor: state.cursor,
      authorityEpoch: Number(metadata.authorityEpoch),
      schemaVersion: Number(metadata.schemaVersion),
      configuration: durabilityMetadataConfigurationIdentity(metadata),
      operatorIdentity: metadata.operatorIdentity,
      database: {
        size: databaseBytes.byteLength,
        digest: durabilityDigestBytes(databaseBytes),
      },
      referencedArtifacts,
    });
    durabilityWriteImmutableJson(
      durabilityJoin(temporaryDirectory, "manifest.json"),
      temporaryDirectory,
      manifest,
    );
    durabilityChmodSync(databasePath, 0o400);
    durabilitySyncPath(temporaryDirectory);
    const finalDirectory = durabilityJoin(
      layout.generationsDirectory,
      durabilityGenerationDirectoryName(manifest),
    );
    if (durabilityExistsSync(finalDirectory)) {
      durabilityRmSync(temporaryDirectory, { recursive: true });
      return;
    }
    durabilityRenameSync(temporaryDirectory, finalDirectory);
    durabilitySyncPath(layout.generationsDirectory);
  } catch (error) {
    durabilityRmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function durabilityReadVerifiedGenerations(layout) {
  const generations = [];
  for (const name of durabilityReaddirSync(layout.generationsDirectory).sort()) {
    if (name.startsWith(".tmp-")) {
      continue;
    }
    const directory = durabilityJoin(layout.generationsDirectory, name);
    const manifestPath = durabilityJoin(directory, "manifest.json");
    const databasePath = durabilityJoin(directory, "runtime-core.sqlite3");
    if (
      !durabilityExistsSync(manifestPath) ||
      !durabilityExistsSync(databasePath)
    ) {
      continue;
    }
    try {
      const manifest = JSON.parse(durabilityReadFileSync(manifestPath, "utf8"));
      durabilityVerifyGenerationManifest(manifest);
      const databaseBytes = durabilityReadFileSync(databasePath);
      if (
        databaseBytes.byteLength !== manifest.database.size ||
        durabilityDigestBytes(databaseBytes) !== manifest.database.digest
      ) {
        throw new Error("recovery generation database digest does not verify");
      }
      const database = new DurabilityDatabaseSync(databasePath, {
        readOnly: true,
      });
      try {
        if (
          database.prepare("PRAGMA integrity_check").get().integrity_check !==
            "ok" ||
          database.prepare("PRAGMA foreign_key_check").all().length > 0
        ) {
          throw new Error("recovery generation database integrity check failed");
        }
        const state = durabilityReadState(database);
        const metadata = durabilityReadMetadata(database);
        if (
          canonicalJson(state.cursor) !== canonicalJson(manifest.cursor) ||
          Number(metadata.authorityEpoch) !== manifest.authorityEpoch ||
          Number(metadata.schemaVersion) !== manifest.schemaVersion ||
          metadata.operatorIdentity !== manifest.operatorIdentity ||
          canonicalJson(durabilityMetadataConfigurationIdentity(metadata)) !==
            canonicalJson(manifest.configuration)
        ) {
          throw new Error("recovery generation metadata does not verify");
        }
        const referencedArtifacts =
          durabilityReadReferencedArtifacts(database);
        if (
          canonicalJson(referencedArtifacts) !==
          canonicalJson(manifest.referencedArtifacts)
        ) {
          throw new Error("recovery generation artifacts do not verify");
        }
        for (const artifact of manifest.referencedArtifacts) {
          durabilityVerifyObject(layout.recoveryRoot, artifact);
        }
      } finally {
        database.close();
      }
      generations.push({ directory, databasePath, manifest });
    } catch {
      // A corrupt or incomplete generation is not offered for restore.
    }
  }
  return generations;
}

function durabilityBuildRecoveryPoint(generation, capsules, layout) {
  const tail = capsules
    .filter(
      (capsule) => capsule.revision > generation.manifest.cursor.revision,
    )
    .sort((left, right) => left.revision - right.revision);
  let targetCursor = generation.manifest.cursor;
  let valid = true;
  const referencedArtifacts = new Map(
    generation.manifest.referencedArtifacts.map((artifact) => [
      artifact.digest,
      artifact,
    ]),
  );
  for (const capsule of tail) {
    if (
      capsule.revision !== targetCursor.revision + 1 ||
      capsule.predecessor !== targetCursor.commitId ||
      capsule.authorityEpoch !== generation.manifest.authorityEpoch ||
      capsule.schemaVersion !== generation.manifest.schemaVersion ||
      canonicalJson(capsule.configuration) !==
        canonicalJson(generation.manifest.configuration)
    ) {
      valid = false;
      break;
    }
    targetCursor = {
      revision: capsule.revision,
      commitId: capsule.commitId,
    };
    for (const artifact of capsule.artifacts) {
      const prior = referencedArtifacts.get(artifact.digest);
      if (prior !== undefined && prior.size !== artifact.size) {
        valid = false;
        break;
      }
      referencedArtifacts.set(artifact.digest, artifact);
    }
  }
  if (valid) {
    try {
      for (const artifact of referencedArtifacts.values()) {
        durabilityVerifyObject(layout.recoveryRoot, artifact);
      }
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    return null;
  }
  return {
    generation,
    tail,
    public: {
      id: `recovery-point:${canonicalDigest({
        generation: generation.manifest.manifestDigest,
        tail: tail.map((capsule) => capsule.capsuleDigest),
      }).slice("sha256:".length)}`,
      sourceCursor: structuredClone(generation.manifest.cursor),
      targetCursor: structuredClone(targetCursor),
      authorityEpoch: generation.manifest.authorityEpoch,
      configurationRevision: generation.manifest.configuration.revision,
      effectiveConfigurationDigest:
        generation.manifest.configuration.digest,
      secretReferenceGenerations: structuredClone(
        generation.manifest.configuration.secretReferenceGenerations,
      ),
      capsuleTailLength: tail.length,
      referencedArtifactCount: referencedArtifacts.size,
    },
  };
}

function durabilityAnalyzeRecovery(layout, options) {
  const allVerified = durabilityReadVerifiedGenerations(layout);
  const expectedConfiguration = durabilityOptionsConfigurationIdentity(options);
  const operatorGenerations = allVerified.filter(
    ({ manifest }) => manifest.operatorIdentity === options.operatorIdentity,
  );
  const maximumAuthorityEpoch = Math.max(
    0,
    ...operatorGenerations.map(({ manifest }) => manifest.authorityEpoch),
  );
  const highestEpochGenerations = operatorGenerations.filter(
    ({ manifest }) => manifest.authorityEpoch === maximumAuthorityEpoch,
  );
  const capsules = durabilityReadCapsules(layout);
  const candidates = highestEpochGenerations
    .map((generation) =>
      durabilityBuildRecoveryPoint(generation, capsules, layout),
    )
    .filter((point) => point !== null);
  const maximumTargetRevision = Math.max(
    -1,
    ...candidates.map((point) => point.public.targetCursor.revision),
  );
  const authoritativePoints = candidates
    .filter(
      (point) => point.public.targetCursor.revision === maximumTargetRevision,
    )
    .sort(
      (left, right) =>
        right.public.sourceCursor.revision - left.public.sourceCursor.revision,
    );
  const authoritativeHeads = new Set(
    authoritativePoints.map((point) => canonicalJson(point.public.targetCursor)),
  );
  if (authoritativeHeads.size > 1) {
    throw new Error("recovery has conflicting authoritative recovery heads");
  }
  const authoritativeConfigurations = new Set(
    authoritativePoints.map((point) =>
      canonicalJson(point.generation.manifest.configuration),
    ),
  );
  if (authoritativeConfigurations.size > 1) {
    throw new Error("recovery head has conflicting configuration identities");
  }
  const configurationAvailable =
    authoritativePoints.length > 0 &&
    canonicalJson(authoritativePoints[0].generation.manifest.configuration) ===
      canonicalJson(expectedConfiguration);
  const availablePoints = configurationAvailable ? authoritativePoints : [];
  const recoveryPoints = availablePoints.map((point) => point.public);
  const latestUnavailable = highestEpochGenerations
    .sort(
      (left, right) =>
        right.manifest.cursor.revision - left.manifest.cursor.revision,
    )[0];
  const unavailableRecoveryPoints =
    recoveryPoints.length > 0 ||
    latestUnavailable === undefined ||
    canonicalJson(latestUnavailable.manifest.configuration) ===
      canonicalJson(expectedConfiguration)
      ? []
      : [
          {
            sourceCursor: structuredClone(latestUnavailable.manifest.cursor),
            reason: "ConfigurationOrSecretGenerationUnavailable",
            requiredConfigurationRevision:
              latestUnavailable.manifest.configuration.revision,
            requiredEffectiveConfigurationDigest:
              latestUnavailable.manifest.configuration.digest,
            requiredSecretReferenceGenerations: structuredClone(
              latestUnavailable.manifest.configuration
                .secretReferenceGenerations,
            ),
          },
        ];
  const authoritativePoint = authoritativePoints[0];
  return {
    availablePoints,
    authoritativePoints,
    authority:
      authoritativePoint === undefined
        ? null
        : {
            cursor: structuredClone(authoritativePoint.public.targetCursor),
            authorityEpoch: authoritativePoint.public.authorityEpoch,
            schemaVersion:
              authoritativePoint.generation.manifest.schemaVersion,
            configuration: structuredClone(
              authoritativePoint.generation.manifest.configuration,
            ),
          },
    cursor:
      authoritativePoint?.public.targetCursor ?? {
        revision: 0,
        commitId: DURABILITY_GENESIS_COMMIT_ID,
      },
    maximumAuthorityEpoch,
    recoveryPoints,
    unavailableRecoveryPoints,
  };
}

function durabilityReadRecoveryRequest(layout, analysis, requestId, requestDigest) {
  const receiptCapsules = durabilityReadReceiptCapsules(layout);
  const exactReceipt = receiptCapsules.find(
    (capsule) =>
      capsule.request.id === requestId &&
      capsule.request.digest === requestDigest,
  );
  if (exactReceipt !== undefined) {
    return {
      requestDigest: exactReceipt.request.digest,
      receipt: structuredClone(exactReceipt.receipt),
    };
  }

  const identities = receiptCapsules
    .filter(
      (capsule) =>
        capsule.request.id === requestId && capsule.conflictWithDigest === null,
    )
    .map((capsule) => ({
      requestDigest: capsule.request.digest,
      receipt: capsule.receipt,
    }));
  const point = analysis.authoritativePoints[0];
  if (point !== undefined) {
    const database = new DurabilityDatabaseSync(point.generation.databasePath, {
      readOnly: true,
    });
    try {
      identities.push(
        ...database
          .prepare(
            `SELECT request_digest, receipt_json
             FROM request_receipts WHERE request_id = ?
             UNION ALL
             SELECT request_digest, receipt_json
             FROM recovery_activations WHERE request_id = ?`,
          )
          .all(requestId, requestId)
          .map((row) => ({
            requestDigest: row.request_digest,
            receipt: JSON.parse(row.receipt_json),
          })),
      );
    } finally {
      database.close();
    }
    const tailCapsule = point.tail.find(
      (capsule) => capsule.request.id === requestId,
    );
    if (tailCapsule !== undefined) {
      identities.push({
        requestDigest: tailCapsule.request.digest,
        receipt: tailCapsule.receipt,
      });
    }
  }
  const distinctIdentities = new Map(
    identities.map((identity) => [identity.requestDigest, identity]),
  );
  if (distinctIdentities.size > 1) {
    throw new Error("request identity conflicts inside the recovery boundary");
  }
  const [authoritative] = distinctIdentities.values();
  if (authoritative === undefined) {
    return null;
  }
  if (authoritative.requestDigest === requestDigest) {
    return {
      requestDigest: authoritative.requestDigest,
      receipt: structuredClone(authoritative.receipt),
    };
  }
  return {
    conflictWithDigest: authoritative.requestDigest,
    priorReceipt: structuredClone(authoritative.receipt),
  };
}

function durabilityRejectRecovery(layout, analysis, candidate) {
  if (analysis.authority === null) {
    throw new Error("recovery has no authoritative head for a durable receipt");
  }
  if (
    canonicalJson(candidate.receipt.cursor) !==
    canonicalJson(analysis.authority.cursor)
  ) {
    throw new Error("recovery rejection receipt cursor is stale");
  }
  const capsule = durabilityBuildReceiptCapsuleForAuthority(
    analysis.authority,
    candidate,
  );
  const existing = durabilityReadReceiptCapsules(layout).find(
    (item) =>
      item.request.id === candidate.requestId &&
      item.request.digest === candidate.requestDigest,
  );
  if (existing !== undefined) {
    if (
      existing.capsuleDigest !== capsule.capsuleDigest ||
      canonicalJson(existing.receipt) !== canonicalJson(candidate.receipt)
    ) {
      throw new Error("durable recovery rejection differs from its receipt");
    }
    return structuredClone(existing.receipt);
  }
  durabilityWriteImmutableJson(
    durabilityReceiptCapsulePath(layout, capsule),
    layout.receiptsDirectory,
    capsule,
  );
  const verified = durabilityReadReceiptCapsules(layout).find(
    (item) => item.capsuleDigest === capsule.capsuleDigest,
  );
  if (verified === undefined) {
    throw new Error("recovery rejection receipt was not durably verified");
  }
  return structuredClone(verified.receipt);
}

function durabilityRecoveryRequired(layout, options) {
  const analysis = durabilityAnalyzeRecovery(layout, options);
  return {
    kind: "RecoveryRequired",
    inspect() {
      return {
        cursor: structuredClone(analysis.cursor),
        run: null,
        latestReceipt: null,
        offers: [],
        authorityEpoch: analysis.maximumAuthorityEpoch,
        recovery: {
          status: "RecoveryRequired",
          condition: "Waiting for Operator",
          recoveryPoints: structuredClone(analysis.recoveryPoints),
          ...(analysis.unavailableRecoveryPoints.length === 0
            ? {}
            : {
                unavailableRecoveryPoints: structuredClone(
                  analysis.unavailableRecoveryPoints,
                ),
              }),
        },
      };
    },
    receipt(requestId, requestDigest) {
      return durabilityReadRecoveryRequest(
        layout,
        analysis,
        requestId,
        requestDigest,
      );
    },
    reject(candidate) {
      return durabilityRejectRecovery(layout, analysis, candidate);
    },
    restore({
      request,
      requestDigest,
      recoveryPointId,
      restoredAt,
      replacementOffer,
    }) {
      const selected = analysis.availablePoints.find(
        (point) => point.public.id === recoveryPointId,
      );
      if (selected === undefined) {
        throw new Error("Restore recovery point is not verified and offered");
      }
      return durabilityRestorePrimary({
        layout,
        options,
        selected,
        request,
        requestDigest,
        restoredAt,
        replacementOffer,
      });
    },
    close() {},
  };
}

function durabilityRestorePrimary({
  layout,
  options,
  selected,
  request,
  requestDigest,
  restoredAt,
  replacementOffer,
}) {
  const currentAnalysis = durabilityAnalyzeRecovery(layout, options);
  const selectedStillOffered = currentAnalysis.availablePoints.some(
    (point) => point.public.id === selected.public.id,
  );
  const verifiedGeneration = durabilityReadVerifiedGenerations(layout).find(
    ({ manifest }) =>
      manifest.manifestDigest === selected.generation.manifest.manifestDigest,
  );
  const verifiedPoint =
    verifiedGeneration === undefined
      ? null
      : durabilityBuildRecoveryPoint(
          verifiedGeneration,
          durabilityReadCapsules(layout),
          layout,
        );
  if (
    !selectedStillOffered ||
    verifiedPoint === null ||
    canonicalJson(verifiedPoint.public) !== canonicalJson(selected.public)
  ) {
    throw new Error(
      "recovery point changed after Observe and must be selected again",
    );
  }
  selected = verifiedPoint;
  const lockDirectory = durabilityJoin(
    options.recoveryRoot,
    ".restore-activation-lock",
  );
  const activeDatabasePath = durabilityDatabasePath(options.primaryRoot);
  const candidatePath = durabilityJoin(
    options.primaryRoot,
    `.restore-candidate-${durabilityRandomUUID()}.sqlite3`,
  );
  let candidate;
  let lockAcquired = false;
  try {
    durabilityMkdirSync(lockDirectory);
    lockAcquired = true;
    durabilitySyncPath(options.recoveryRoot);
    durabilityMkdirSync(options.primaryRoot, { recursive: true });
    if (durabilityExistsSync(activeDatabasePath)) {
      throw new Error("primary storage reappeared before Restore activation");
    }
    durabilityCopyFileSync(selected.generation.databasePath, candidatePath);
    const candidateBytes = durabilityReadFileSync(candidatePath);
    if (
      candidateBytes.byteLength !== selected.generation.manifest.database.size ||
      durabilityDigestBytes(candidateBytes) !==
        selected.generation.manifest.database.digest
    ) {
      throw new Error("recovery point changed while rebuilding its candidate");
    }
    durabilityChmodSync(candidatePath, 0o600);
    durabilitySyncPath(candidatePath);
    candidate = new DurabilityDatabaseSync(candidatePath);
    candidate.exec("PRAGMA synchronous=FULL");
    candidate.exec("PRAGMA foreign_keys=ON");
    for (const capsule of selected.tail) {
      durabilityApplyCapsule(candidate, capsule, layout);
    }
    durabilityRecoverReceiptCapsules(candidate, layout);
    const referencedArtifacts = durabilityReadReferencedArtifacts(candidate);
    for (const artifact of referencedArtifacts) {
      const bytes = durabilityVerifyObject(layout.recoveryRoot, artifact);
      durabilityPromoteObject(layout.primaryRoot, { ...artifact, bytes });
    }
    const before = durabilityReadState(candidate);
    const metadata = durabilityReadMetadata(candidate);
    if (
      canonicalJson(before.cursor) !==
        canonicalJson(selected.public.targetCursor) ||
      Number(metadata.authorityEpoch) !== selected.public.authorityEpoch
    ) {
      throw new Error("Restore candidate does not match the selected recovery point");
    }
    const authorityEpoch = Number(metadata.authorityEpoch) + 1;
    const pendingEffects = candidate
      .prepare(
        `SELECT effect_intent_id FROM effect_intents
         WHERE disposition IN ('Pending', 'Active', 'Uncertain')
         ORDER BY effect_intent_id`,
      )
      .all()
      .map((row) => row.effect_intent_id);
    const recoveryGate =
      pendingEffects.length === 0 ? "Open" : "Reconciliation";
    const receipt = {
      status: "accepted",
      requestId: request.requestId,
      actionKind: "Restore",
      recoveryPoint: selected.public.id,
      cursor: structuredClone(before.cursor),
      authorityEpoch,
      recoveryGate,
      restoredAt,
    };

    candidate.exec("BEGIN IMMEDIATE");
    try {
      candidate
        .prepare("UPDATE metadata SET value = ? WHERE key = 'authorityEpoch'")
        .run(String(authorityEpoch));
      candidate
        .prepare("UPDATE metadata SET value = ? WHERE key = 'recoveryGate'")
        .run(pendingEffects.length === 0 ? "open" : "reconciliation");
      candidate
        .prepare(
          `INSERT INTO recovery_activations
             (request_id, request_digest, receipt_json,
              source_recovery_point, source_manifest_digest, restored_at,
              authority_epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.requestId,
          requestDigest,
          canonicalJson(receipt),
          selected.public.id,
          selected.generation.manifest.manifestDigest,
          restoredAt,
          authorityEpoch,
        );
      candidate
        .prepare(
          `UPDATE recovery_effects SET status = 'LateEvidenceOnly'
           WHERE status = 'Pending'`,
        )
        .run();
      for (const effectIntentId of pendingEffects) {
        candidate
          .prepare(
            `INSERT INTO recovery_effects
               (effect_intent_id, authority_epoch, status)
             VALUES (?, ?, 'Pending')`,
          )
          .run(effectIntentId, authorityEpoch);
      }
      candidate
        .prepare(
          `UPDATE operator_offers SET consumed_revision = revision
           WHERE consumed_revision IS NULL`,
        )
        .run();
      if (before.run === null) {
        candidate
          .prepare(
            `INSERT INTO operator_offers
               (offer, principal, revision, authority_epoch, action_kind,
                constraints_json, consumed_revision)
             VALUES (?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            replacementOffer.offer,
            replacementOffer.principal,
            before.cursor.revision,
            authorityEpoch,
            replacementOffer.actionKind,
            canonicalJson(replacementOffer.constraints),
          );
      }
      candidate.exec("COMMIT");
    } catch (error) {
      candidate.exec("ROLLBACK");
      throw error;
    }
    if (
      candidate.prepare("PRAGMA integrity_check").get().integrity_check !== "ok"
    ) {
      throw new Error("restored candidate failed SQLite integrity verification");
    }
    if (before.cursor.revision > 0) {
      durabilityVerifyCommit(
        candidate,
        durabilityReadCapsules(layout),
        before.cursor.commitId,
        layout,
      );
    }
    const verified = durabilityReadState(candidate);
    if (
      verified.authorityEpoch !== authorityEpoch ||
      canonicalJson(verified.cursor) !== canonicalJson(before.cursor) ||
      canonicalJson(verified.run) !== canonicalJson(before.run) ||
      canonicalJson(verified.latestReceipt) !==
        canonicalJson(before.latestReceipt)
    ) {
      throw new Error("restored candidate changed acknowledged Run state");
    }
    candidate.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    durabilityCreateGeneration(candidate, layout);
    candidate.close();
    candidate = undefined;
    durabilitySyncPath(candidatePath);
    durabilityRenameSync(candidatePath, activeDatabasePath);
    durabilitySyncPath(options.primaryRoot);

    const activated = durabilityOpenDatabase(options.primaryRoot);
    try {
      durabilityRecoverAndVerify(activated, layout);
      const state = durabilityReadState(activated);
      return { receipt: structuredClone(receipt), state };
    } finally {
      activated.close();
    }
  } finally {
    candidate?.close();
    durabilityRmSync(candidatePath, { force: true });
    durabilityRmSync(`${candidatePath}-wal`, { force: true });
    durabilityRmSync(`${candidatePath}-shm`, { force: true });
    if (lockAcquired) {
      durabilityRmSync(lockDirectory, { recursive: true, force: true });
      durabilitySyncPath(options.recoveryRoot);
    }
  }
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
  durabilityRequireSecretReferenceGenerations(
    capsule.configuration?.secretReferenceGenerations,
  );
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
  return durabilityUseWriterTransaction(database, transactionOpen, () => {
    durabilityVerifyReceiptCapsule(capsule);
    const authoritativeRequest = database
      .prepare(
        `SELECT request_digest, disposition, receipt_json,
                receipt_capsule_digest
         FROM request_receipts WHERE request_id = ?`,
      )
      .get(capsule.request.id);
    const recoveryActivation = database
      .prepare(
        `SELECT request_digest FROM recovery_activations
         WHERE request_id = ?`,
      )
      .get(capsule.request.id);
    const authoritativeDigest =
      authoritativeRequest?.request_digest ??
      recoveryActivation?.request_digest;
    const isConflict = capsule.conflictWithDigest !== null;
    if (isConflict) {
      if (
        authoritativeDigest === undefined ||
        authoritativeDigest !== capsule.conflictWithDigest ||
        authoritativeDigest === capsule.request.digest
      ) {
        throw new Error(
          "request conflict receipt has no durable original request",
        );
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
      canonicalJson(durabilityMetadataConfigurationIdentity(metadata)) !==
        canonicalJson(capsule.configuration)
    ) {
      throw new Error("rejection receipt authority or configuration is stale");
    }
    durabilityVerifyReceiptCursor(database, capsule.cursor);

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
  });
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

function durabilityApplyCapsule(
  database,
  capsule,
  layout,
  transactionOpen = false,
) {
  return durabilityUseWriterTransaction(database, transactionOpen, () => {
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
      canonicalJson(durabilityMetadataConfigurationIdentity(metadata)) !==
        canonicalJson(capsule.configuration)
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
      offer.authorityEpoch !== capsule.authorityEpoch ||
      offer.actionKind !== capsule.audit.actionKind ||
      canonicalDigest(offer.constraints) !==
        capsule.authorization.offerConstraintsDigest ||
      offer.consumedRevision !== null
    ) {
      throw new Error("recovery capsule no longer has its authoritative offer");
    }
    for (const artifact of capsule.artifacts) {
      const bytes = durabilityVerifyObject(layout.recoveryRoot, artifact);
      durabilityPromoteObject(layout.primaryRoot, {
        ...artifact,
        bytes,
      });
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
    for (const artifact of capsule.artifacts) {
      database
        .prepare("INSERT OR IGNORE INTO artifacts (digest, size) VALUES (?, ?)")
        .run(artifact.digest, artifact.size);
      const authoritativeArtifact = database
        .prepare("SELECT size FROM artifacts WHERE digest = ?")
        .get(artifact.digest);
      if (authoritativeArtifact.size !== artifact.size) {
        throw new Error("artifact identity has another authoritative size");
      }
      database
        .prepare(
          `INSERT INTO artifact_relationships
             (commit_id, artifact_digest) VALUES (?, ?)`,
        )
        .run(capsule.commitId, artifact.digest);
    }
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
  });
}

function durabilityVerifyCommit(database, capsules, commitId, layout) {
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
  const artifacts = database
    .prepare(
      `SELECT a.digest, a.size
       FROM artifact_relationships ar
       JOIN artifacts a ON a.digest = ar.artifact_digest
       WHERE ar.commit_id = ? ORDER BY a.digest`,
    )
    .all(capsule.commitId);
  if (canonicalJson(artifacts) !== canonicalJson(capsule.artifacts)) {
    throw new Error("authoritative artifacts differ from their capsule");
  }
  for (const artifact of capsule.artifacts) {
    durabilityVerifyObject(layout.primaryRoot, artifact);
    durabilityVerifyObject(layout.recoveryRoot, artifact);
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
      consumedOffer.authorityEpoch !== capsule.authorityEpoch ||
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

function durabilityRecoverAndVerify(
  database,
  layout,
  transactionOpen = false,
) {
  return durabilityUseWriterTransaction(database, transactionOpen, () => {
    const { capsules, prepared } = durabilityPreparedCapsules(database, layout);
    if (prepared.length > 1) {
      throw new Error("multiple prepared recovery capsules require recovery");
    }
    if (prepared.length === 1) {
      durabilityApplyCapsule(database, prepared[0], layout, true);
    }

    const state = durabilityReadState(database);
    if (state.cursor.revision === 0) {
      if (state.cursor.commitId !== DURABILITY_GENESIS_COMMIT_ID) {
        throw new Error("genesis projection has an invalid commit identity");
      }
    } else {
      durabilityVerifyCommit(database, capsules, state.cursor.commitId, layout);
    }
    durabilityRecoverReceiptCapsules(database, layout, true);
  });
}

function durabilityRecoverReceiptCapsules(
  database,
  layout,
  transactionOpen = false,
) {
  return durabilityUseWriterTransaction(database, transactionOpen, () => {
    const receiptCapsules = durabilityReadReceiptCapsules(layout);
    for (const capsule of receiptCapsules) {
      durabilityApplyReceiptCapsule(database, capsule, true);
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
  });
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
    configuration: durabilityMetadataConfigurationIdentity(metadata),
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
    artifacts: candidate.artifacts
      .map(({ digest, size }) => ({ digest, size }))
      .sort((left, right) => left.digest.localeCompare(right.digest)),
  });
}

function durabilityBuildReceiptCapsule(database, candidate) {
  const metadata = durabilityReadMetadata(database);
  return durabilityBuildReceiptCapsuleForAuthority(
    {
      authorityEpoch: Number(metadata.authorityEpoch),
      schemaVersion: Number(metadata.schemaVersion),
      configuration: durabilityMetadataConfigurationIdentity(metadata),
      cursor: candidate.receipt.cursor,
    },
    candidate,
  );
}

function durabilityBuildReceiptCapsuleForAuthority(authority, candidate) {
  return durabilitySealCapsule({
    format: "openab.rejection-receipt/v1",
    authorityEpoch: authority.authorityEpoch,
    schemaVersion: authority.schemaVersion,
    configuration: structuredClone(authority.configuration),
    cursor: structuredClone(authority.cursor),
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

function durabilityCommitCandidate(
  database,
  layout,
  candidate,
  transactionOpen = false,
) {
  return durabilityUseWriterTransaction(database, transactionOpen, () => {
    const artifacts = durabilityNormalizeArtifacts(candidate.artifacts ?? []);
    for (const artifact of artifacts) {
      durabilityPromoteObject(layout.primaryRoot, artifact);
      durabilityPromoteObject(layout.recoveryRoot, artifact);
    }
    candidate = { ...candidate, artifacts };
    let capsule;
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
      durabilityApplyCapsule(database, capsule, layout, true);
    }
    durabilityVerifyCommit(
      database,
      durabilityReadCapsules(layout),
      capsule.commitId,
      layout,
    );
    return structuredClone(capsule.receipt);
  });
}

function durabilityRecordRejection(
  database,
  layout,
  candidate,
  transactionOpen = false,
) {
  return durabilityUseWriterTransaction(database, transactionOpen, () => {
    let capsule;
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
    const recoveryActivation = database
      .prepare(
        `SELECT request_digest FROM recovery_activations
         WHERE request_id = ?`,
      )
      .get(candidate.requestId);
    const authoritativeDigest =
      authoritativeRequest?.request_digest ??
      recoveryActivation?.request_digest;
    const isConflict = candidate.conflictWithDigest !== undefined;
    const existingAuthoritative =
      !isConflict &&
      authoritativeRequest?.request_digest === candidate.requestDigest &&
      authoritativeRequest.disposition === "rejected";
    if (
      (!isConflict &&
        authoritativeDigest !== undefined &&
        !existingAuthoritative) ||
      (isConflict &&
        authoritativeDigest !== candidate.conflictWithDigest)
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
    durabilityVerifyRejectionReceipt(
      database,
      durabilityReadReceiptCapsules(layout),
      candidate.requestId,
      candidate.requestDigest,
    );
    return structuredClone(capsule.receipt);
  });
}

function durabilityReceipt(
  database,
  layout,
  requestId,
  requestDigest,
  transactionOpen = false,
) {
  return durabilityUseWriterTransaction(database, transactionOpen, () => {
    const receiptCapsules = durabilityRecoverReceiptCapsules(
      database,
      layout,
      true,
    );
    const recoveryActivation = database
      .prepare(
        `SELECT request_digest, receipt_json
         FROM recovery_activations WHERE request_id = ?`,
      )
      .get(requestId);
    if (recoveryActivation !== undefined) {
      if (recoveryActivation.request_digest !== requestDigest) {
        const conflict = database
          .prepare(
            `SELECT request_digest, receipt_json
             FROM request_conflict_receipts
             WHERE request_id = ? AND request_digest = ?`,
          )
          .get(requestId, requestDigest);
        if (conflict !== undefined) {
          durabilityVerifyRejectionReceipt(
            database,
            receiptCapsules,
            requestId,
            requestDigest,
          );
          return {
            requestDigest: conflict.request_digest,
            receipt: JSON.parse(conflict.receipt_json),
          };
        }
        return {
          conflictWithDigest: recoveryActivation.request_digest,
          priorReceipt: JSON.parse(recoveryActivation.receipt_json),
        };
      }
      return {
        requestDigest: recoveryActivation.request_digest,
        receipt: JSON.parse(recoveryActivation.receipt_json),
      };
    }
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
        receiptCapsules,
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
        layout,
      );
    } else if (row.disposition === "rejected") {
      durabilityVerifyRejectionReceipt(
        database,
        receiptCapsules,
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
  });
}

function durabilityOperations(database, layout) {
  return {
    inspect() {
      return durabilityReadState(database);
    },

    receipt(requestId, requestDigest) {
      return durabilityReceipt(
        database,
        layout,
        requestId,
        requestDigest,
        true,
      );
    },

    commit(candidate) {
      return durabilityCommitCandidate(
        database,
        layout,
        candidate,
        true,
      );
    },

    reject(candidate) {
      return durabilityRecordRejection(
        database,
        layout,
        candidate,
        true,
      );
    },
  };
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
  durabilityRequireSecretReferenceGenerations(
    options.secretReferenceGenerations,
  );
  const layout = durabilityRecoveryLayout(
    options.recoveryRoot,
    options.primaryRoot,
  );
  const databaseExisted = durabilityExistsSync(
    durabilityDatabasePath(options.primaryRoot),
  );
  if (
    !databaseExisted &&
    durabilityReaddirSync(layout.generationsDirectory).length > 0
  ) {
    return durabilityRecoveryRequired(layout, options);
  }
  const database = durabilityOpenDatabase(options.primaryRoot);
  try {
    durabilityInitialize(database, options);
    durabilityRecoverAndVerify(database, layout);
    durabilityCreateGeneration(database, layout);
  } catch (error) {
    database.close();
    throw error;
  }

  return {
    kind: "Open",
    inspect() {
      return durabilityReadState(database);
    },

    act(operation) {
      const result = durabilityUseWriterTransaction(database, false, () => {
        durabilityRecoverAndVerify(database, layout, true);
        return operation(durabilityOperations(database, layout));
      });
      durabilityCreateGeneration(database, layout);
      return result;
    },

    close() {
      database.close();
    },
  };
}
