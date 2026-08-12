#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCT = Object.freeze({
  name: "openab-orchestration",
  version: "0.1.0",
});

export const PROCESS_MODES = Object.freeze([
  Object.freeze({ id: "runtime-core", name: "Runtime Core" }),
  Object.freeze({ id: "execution-worker", name: "Execution Worker" }),
  Object.freeze({ id: "github-publisher", name: "GitHub Publisher" }),
  Object.freeze({
    id: "discord-operator-interface",
    name: "Discord Operator Interface",
  }),
]);

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parsePreflightArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--config" && flag !== "--product-root") || !value) {
      throw new Error(
        "Usage: openab-orchestration preflight --config <path> --product-root <path>",
      );
    }
    options[flag.slice(2)] = value;
  }
  if (!options.config || !options["product-root"]) {
    throw new Error(
      "Usage: openab-orchestration preflight --config <path> --product-root <path>",
    );
  }
  return options;
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

function configurationDigest(configuration) {
  const bytes = JSON.stringify(canonicalize(configuration));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const WORKER_CONFIG_KEYS = Object.freeze({
  "execution-worker": "executionWorker",
  "github-publisher": "githubPublisher",
  "discord-operator-interface": "discordOperatorInterface",
});

const REQUIRED_SECRET_PURPOSES = Object.freeze({
  "execution-worker": Object.freeze([
    "provider-authentication",
    "acp-transport-authentication",
  ]),
  "github-publisher": Object.freeze(["github-publication-authentication"]),
  "discord-operator-interface": Object.freeze([
    "discord-bot-authentication",
  ]),
});

class PreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
}

function requireOnlyKeys(value, allowedKeys, field, code = "CONFIGURATION_CONTRACT_VIOLATION") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PreflightError(code, `${field} must be an object`);
  }
  const unexpectedKeys = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unexpectedKeys.length > 0) {
    throw new PreflightError(
      code,
      `${field} contains unsupported fields: ${unexpectedKeys.join(", ")}`,
    );
  }
}

function requireConfigurationEnvelope(configuration) {
  requireOnlyKeys(
    configuration,
    [
      "$schema",
      "apiVersion",
      "kind",
      "metadata",
      "processes",
      "storage",
      "workspace",
      "authority",
      "policy",
      "workers",
    ],
    "configuration",
  );
  if (configuration.apiVersion !== "openab.dev/v1alpha1") {
    throw new PreflightError(
      "CONFIGURATION_CONTRACT_VIOLATION",
      "apiVersion must be openab.dev/v1alpha1",
    );
  }
  requireOnlyKeys(configuration.metadata, ["revision"], "metadata");
  configuration.policy ??= {
    reviewerDiversity: "distinct-serving-providers",
  };
  requireOnlyKeys(configuration.policy, ["reviewerDiversity"], "policy");
}

const SECRET_PAYLOAD_KEYS = new Set([
  "secret",
  "secretpayload",
  "secretvalue",
  "password",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "privatekey",
  "credential",
  "credentialpayload",
  "credentialvalue",
]);

function rejectSecretPayloadFields(value, path = "configuration") {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectSecretPayloadFields(item, `${path}[${index}]`),
    );
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    if (SECRET_PAYLOAD_KEYS.has(normalizedKey)) {
      throw new PreflightError(
        "SECRET_PAYLOAD_FORBIDDEN",
        `${path}.${key} supplies Secret Material; use a worker-owned secret reference`,
      );
    }
    rejectSecretPayloadFields(child, `${path}.${key}`);
  }
}

function pathIsWithin(candidate, parent) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== ".." &&
      !isAbsolute(pathFromParent))
  );
}

function validatePrivatePath(path, field, productRoot) {
  let canonicalPath;
  let canonicalProductRoot;
  try {
    canonicalPath = realpathSync(path);
    canonicalProductRoot = realpathSync(productRoot);
  } catch (error) {
    throw new PreflightError(
      "PRIVATE_PATH_UNAVAILABLE",
      `${field} and product root must resolve to existing locations: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (pathIsWithin(canonicalPath, canonicalProductRoot)) {
    throw new PreflightError(
      "PRIVATE_PATH_IN_CHECKOUT",
      `${field} must resolve outside the Product Repository`,
    );
  }
  return canonicalPath;
}

function requireEnabledProcesses(configuration) {
  const processKeys = [
    "runtimeCore",
    "executionWorker",
    "githubPublisher",
    "discordOperatorInterface",
  ];
  requireOnlyKeys(configuration.processes, processKeys, "processes");
  for (const key of processKeys) {
    requireOnlyKeys(configuration.processes?.[key], ["enabled"], `processes.${key}`);
    if (configuration.processes?.[key]?.enabled !== true) {
      throw new Error(`processes.${key}.enabled must be true`);
    }
  }
}

function requireWorkerPurposes(configuration, mode, key) {
  const references = configuration.workers?.[key]?.secretReferences;
  if (!Array.isArray(references)) {
    throw new Error(`workers.${key}.secretReferences is required`);
  }
  const actualPurposes = references.map(({ purpose }) => purpose).sort();
  const requiredPurposes = [...REQUIRED_SECRET_PURPOSES[mode]].sort();
  if (
    actualPurposes.length !== requiredPurposes.length ||
    actualPurposes.some((purpose, index) => purpose !== requiredPurposes[index])
  ) {
    throw new Error(
      `workers.${key}.secretReferences must define exactly: ${requiredPurposes.join(
        ", ",
      )}`,
    );
  }
  return references;
}

function requirePlaceholder(value, field) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.placeholder !== "string" ||
    value.placeholder.length === 0 ||
    Object.keys(value).some((key) => key !== "placeholder")
  ) {
    throw new PreflightError(
      "SYNTHETIC_BINDINGS_FORBIDDEN",
      `${field} must contain only a descriptive placeholder`,
    );
  }
}

function requireCompleteSyntheticInstallation(configuration) {
  try {
    requireString(configuration.metadata?.revision, "metadata.revision");
    requireEnabledProcesses(configuration);
    requireOnlyKeys(configuration.storage, ["primaryRoot", "recoveryRoot"], "storage");
    requireOnlyKeys(configuration.workspace, ["root"], "workspace");
    requireOnlyKeys(
      configuration.authority,
      ["operatorIdentity", "agentRoleIdentities", "githubTarget", "discordOperator"],
      "authority",
    );
    requireOnlyKeys(
      configuration.authority?.agentRoleIdentities,
      ["orchestrator", "coding", "reviewerA", "reviewerB"],
      "authority.agentRoleIdentities",
    );
    requirePlaceholder(configuration.storage?.primaryRoot, "storage.primaryRoot");
    requirePlaceholder(
      configuration.storage?.recoveryRoot,
      "storage.recoveryRoot",
    );
    requirePlaceholder(configuration.workspace?.root, "workspace.root");
    requirePlaceholder(
      configuration.authority?.operatorIdentity,
      "authority.operatorIdentity",
    );
    for (const role of ["orchestrator", "coding", "reviewerA", "reviewerB"]) {
      requirePlaceholder(
        configuration.authority?.agentRoleIdentities?.[role],
        `authority.agentRoleIdentities.${role}`,
      );
    }
    requirePlaceholder(
      configuration.authority?.githubTarget,
      "authority.githubTarget",
    );
    requirePlaceholder(
      configuration.authority?.discordOperator,
      "authority.discordOperator",
    );
    if (configuration.policy?.reviewerDiversity !== "distinct-serving-providers") {
      throw new Error(
        "policy.reviewerDiversity must be distinct-serving-providers",
      );
    }
    requireOnlyKeys(
      configuration.workers,
      Object.values(WORKER_CONFIG_KEYS),
      "workers",
    );
    for (const [mode, key] of Object.entries(WORKER_CONFIG_KEYS)) {
      requireOnlyKeys(
        configuration.workers?.[key],
        ["secretReferences"],
        `workers.${key}`,
      );
      for (const [index, reference] of requireWorkerPurposes(
        configuration,
        mode,
        key,
      ).entries()) {
        const field = `workers.${key}.secretReferences[${index}]`;
        requireString(reference.purpose, `${field}.purpose`);
        if (
          typeof reference.placeholder !== "string" ||
          reference.placeholder.length === 0 ||
          Object.keys(reference).some(
            (property) => property !== "purpose" && property !== "placeholder",
          )
        ) {
          throw new PreflightError(
            "SYNTHETIC_BINDINGS_FORBIDDEN",
            `${field} must contain only a purpose and descriptive placeholder`,
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof PreflightError) {
      throw error;
    }
    throw new PreflightError(
      "SYNTHETIC_BINDINGS_FORBIDDEN",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function requireCompletePrivateInstallation(configuration, productRoot) {
  requireString(configuration.metadata?.revision, "metadata.revision");
  requireEnabledProcesses(configuration);

  requireOnlyKeys(configuration.storage, ["primaryRoot", "recoveryRoot"], "storage");
  requireOnlyKeys(configuration.storage.primaryRoot, ["path"], "storage.primaryRoot");
  requireOnlyKeys(configuration.storage.recoveryRoot, ["path"], "storage.recoveryRoot");
  requireOnlyKeys(configuration.workspace, ["root"], "workspace");
  requireOnlyKeys(configuration.workspace.root, ["path"], "workspace.root");

  requireString(configuration.storage?.primaryRoot?.path, "storage.primaryRoot.path");
  requireString(
    configuration.storage?.recoveryRoot?.path,
    "storage.recoveryRoot.path",
  );
  requireString(configuration.workspace?.root?.path, "workspace.root.path");
  const primaryRoot = validatePrivatePath(
    configuration.storage.primaryRoot.path,
    "storage.primaryRoot.path",
    productRoot,
  );
  const recoveryRoot = validatePrivatePath(
    configuration.storage.recoveryRoot.path,
    "storage.recoveryRoot.path",
    productRoot,
  );
  validatePrivatePath(
    configuration.workspace.root.path,
    "workspace.root.path",
    productRoot,
  );
  const primaryIdentity = statSync(primaryRoot);
  const recoveryIdentity = statSync(recoveryRoot);
  if (
    primaryRoot === recoveryRoot ||
    (primaryIdentity.dev === recoveryIdentity.dev &&
      primaryIdentity.ino === recoveryIdentity.ino)
  ) {
    throw new PreflightError(
      "STORAGE_ROOTS_NOT_DISTINCT",
      "storage.primaryRoot.path and storage.recoveryRoot.path must resolve to distinct locations",
    );
  }
  requireOnlyKeys(
    configuration.authority,
    ["operatorIdentity", "agentRoleIdentities", "githubTarget", "discordOperator"],
    "authority",
    "AUTHORITY_CONFIGURATION_INCOMPLETE",
  );
  requireOnlyKeys(
    configuration.authority?.operatorIdentity,
    ["id"],
    "authority.operatorIdentity",
    "AUTHORITY_CONFIGURATION_INCOMPLETE",
  );
  requireOnlyKeys(
    configuration.authority?.agentRoleIdentities,
    ["orchestrator", "coding", "reviewerA", "reviewerB"],
    "authority.agentRoleIdentities",
    "AUTHORITY_CONFIGURATION_INCOMPLETE",
  );
  requireString(
    configuration.authority?.operatorIdentity?.id,
    "authority.operatorIdentity.id",
  );
  for (const role of ["orchestrator", "coding", "reviewerA", "reviewerB"]) {
    requireOnlyKeys(
      configuration.authority?.agentRoleIdentities?.[role],
      ["id"],
      `authority.agentRoleIdentities.${role}`,
      "AUTHORITY_CONFIGURATION_INCOMPLETE",
    );
    requireString(
      configuration.authority?.agentRoleIdentities?.[role]?.id,
      `authority.agentRoleIdentities.${role}.id`,
    );
  }
  requireOnlyKeys(
    configuration.authority?.githubTarget,
    ["owner", "repository"],
    "authority.githubTarget",
    "AUTHORITY_CONFIGURATION_INCOMPLETE",
  );
  requireString(configuration.authority?.githubTarget?.owner, "authority.githubTarget.owner");
  requireString(
    configuration.authority?.githubTarget?.repository,
    "authority.githubTarget.repository",
  );
  requireOnlyKeys(
    configuration.authority?.discordOperator,
    ["id"],
    "authority.discordOperator",
    "AUTHORITY_CONFIGURATION_INCOMPLETE",
  );
  requireString(
    configuration.authority?.discordOperator?.id,
    "authority.discordOperator.id",
  );
  if (configuration.policy?.reviewerDiversity !== "distinct-serving-providers") {
    throw new Error(
      "policy.reviewerDiversity must be distinct-serving-providers",
    );
  }

  requireOnlyKeys(
    configuration.workers,
    Object.values(WORKER_CONFIG_KEYS),
    "workers",
  );
  for (const [mode, key] of Object.entries(WORKER_CONFIG_KEYS)) {
    requireOnlyKeys(
      configuration.workers?.[key],
      ["secretReferences"],
      `workers.${key}`,
    );
    const references = requireWorkerPurposes(configuration, mode, key);
    for (const [index, reference] of references.entries()) {
      const field = `workers.${key}.secretReferences[${index}]`;
      requireOnlyKeys(
        reference,
        ["purpose", "provider", "reference", "generation"],
        field,
        "SECRET_PAYLOAD_FORBIDDEN",
      );
      requireString(reference.purpose, `${field}.purpose`);
      if (reference.provider !== "environment" && reference.provider !== "file") {
        throw new Error(`${field}.provider must be environment or file`);
      }
      requireString(reference.reference, `${field}.reference`);
      requireString(reference.generation, `${field}.generation`);
    }
  }
}

function secretReferenceGenerations(configuration) {
  if (configuration.kind === "SyntheticInstallation") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(WORKER_CONFIG_KEYS)
      .flatMap(([mode, key]) =>
        configuration.workers[key].secretReferences.map((reference) => [
          `${mode}/${reference.purpose}`,
          reference.generation,
        ]),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function effectiveConfiguration(configuration) {
  const effective = structuredClone(configuration);
  delete effective.$schema;
  if (configuration.kind === "Installation") {
    for (const key of Object.values(WORKER_CONFIG_KEYS)) {
      effective.workers[key].secretReferences = effective.workers[
        key
      ].secretReferences.map(({ purpose, generation }) => ({
        purpose,
        generation,
      }));
    }
  }
  return effective;
}

class InstallationInspection {
  #configuration;

  constructor(configuration) {
    this.#configuration = structuredClone(configuration);
  }

  runtimeCoreReply() {
    const configuration = this.#configuration;
    return {
      ok: true,
      synthetic: configuration.kind === "SyntheticInstallation",
      contactedExternalInfrastructure: false,
      product: PRODUCT,
      supportedProcessModes: PROCESS_MODES,
      runtimeCore: {
        configurationRevision: configuration.metadata.revision,
        effectiveConfigurationDigest: configurationDigest(
          effectiveConfiguration(configuration),
        ),
        secretReferenceGenerations: secretReferenceGenerations(configuration),
      },
    };
  }

  workerSecretResolutionPlan(mode) {
    if (mode === "runtime-core") {
      throw new Error("Runtime Core does not resolve Secret Material");
    }
    const key = WORKER_CONFIG_KEYS[mode];
    if (!key) {
      throw new Error(`Unsupported worker mode: ${mode}`);
    }
    if (this.#configuration.kind === "SyntheticInstallation") {
      throw new Error("Synthetic Installations have no private secret references");
    }
    return structuredClone({
      configurationRevision: this.#configuration.metadata.revision,
      secretReferences: this.#configuration.workers[key].secretReferences,
    });
  }
}

export function inspectInstallation(configPath, productRoot) {
  requireString(productRoot, "product root");
  const configuration = JSON.parse(readFileSync(configPath, "utf8"));
  rejectSecretPayloadFields(configuration);
  requireConfigurationEnvelope(configuration);
  if (configuration.kind === "SyntheticInstallation") {
    requireCompleteSyntheticInstallation(configuration);
  } else if (configuration.kind === "Installation") {
    let canonicalConfigurationPath;
    let canonicalProductRoot;
    try {
      canonicalConfigurationPath = realpathSync(configPath);
      canonicalProductRoot = realpathSync(productRoot);
    } catch (error) {
      throw new PreflightError(
        "PRIVATE_CONFIGURATION_UNAVAILABLE",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (pathIsWithin(canonicalConfigurationPath, canonicalProductRoot)) {
      throw new PreflightError(
        "PRIVATE_CONFIGURATION_IN_CHECKOUT",
        "Installation Configuration must remain outside the Product Repository checkout",
      );
    }
    try {
      requireCompletePrivateInstallation(configuration, productRoot);
    } catch (error) {
      if (error instanceof PreflightError) {
        throw error;
      }
      throw new PreflightError(
        "AUTHORITY_CONFIGURATION_INCOMPLETE",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else {
    throw new Error("kind must be SyntheticInstallation or Installation");
  }
  return new InstallationInspection(configuration);
}

export function run(args, io = process) {
  const [command] = args;

  if (command === "version") {
    writeJson(io.stdout, PRODUCT);
    return 0;
  }

  if (command === "modes") {
    writeJson(io.stdout, { product: PRODUCT, processModes: PROCESS_MODES });
    return 0;
  }

  if (command === "preflight") {
    try {
      const options = parsePreflightArguments(args.slice(1));
      const installation = inspectInstallation(
        options.config,
        options["product-root"],
      );
      writeJson(io.stdout, installation.runtimeCoreReply());
      return 0;
    } catch (error) {
      writeJson(io.stderr, {
        ok: false,
        error: {
          code:
            error instanceof PreflightError
              ? error.code
              : "PREFLIGHT_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return 2;
    }
  }

  writeJson(io.stderr, {
    ok: false,
    error: {
      code: "USAGE_ERROR",
      message: "Usage: openab-orchestration <version|modes|preflight>",
    },
  });
  return 2;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exitCode = run(process.argv.slice(2));
}
