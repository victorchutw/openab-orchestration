import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PRODUCT,
  PROCESS_MODES,
  inspectInstallation,
  run,
} from "../src/openab-orchestration.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function invoke(args) {
  let stdout = "";
  let stderr = "";
  const exitCode = run(args, {
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  });
  return { exitCode, stdout, stderr };
}

test("the product entry point reports its version and supported process modes", () => {
  const version = invoke(["version"]);
  assert.equal(version.exitCode, 0);
  assert.deepEqual(JSON.parse(version.stdout), PRODUCT);
  assert.equal(version.stderr, "");

  const modes = invoke(["modes"]);
  assert.equal(modes.exitCode, 0);
  assert.deepEqual(JSON.parse(modes.stdout), {
    product: PRODUCT,
    processModes: PROCESS_MODES,
  });
  assert.equal(modes.stderr, "");
});

test("preflight accepts the public synthetic Installation without external contact", () => {
  const result = invoke([
    "preflight",
    "--config",
    resolve(repositoryRoot, "config/examples/synthetic-installation.json"),
    "--product-root",
    repositoryRoot,
  ]);

  assert.equal(result.exitCode, 0, result.stderr);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.ok, true);
  assert.equal(reply.synthetic, true);
  assert.equal(reply.contactedExternalInfrastructure, false);
  assert.deepEqual(reply.product, PRODUCT);
  assert.deepEqual(reply.supportedProcessModes, PROCESS_MODES);
  assert.match(
    reply.runtimeCore.effectiveConfigurationDigest,
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.equal(reply.runtimeCore.configurationRevision, "synthetic-example-v1");
  assert.equal(result.stderr, "");
});

function privateInstallation(root) {
  return {
    apiVersion: "openab.dev/v1alpha1",
    kind: "Installation",
    metadata: { revision: "private-test-v1" },
    processes: {
      runtimeCore: { enabled: true },
      executionWorker: { enabled: true },
      githubPublisher: { enabled: true },
      discordOperatorInterface: { enabled: true },
    },
    storage: {
      primaryRoot: { path: join(root, "primary") },
      recoveryRoot: { path: join(root, "recovery") },
    },
    workspace: { root: { path: join(root, "workspaces") } },
    authority: {
      operatorIdentity: { id: "private-test-operator" },
      agentRoleIdentities: {
        orchestrator: { id: "private-test-orchestrator" },
        coding: { id: "private-test-coding" },
        reviewerA: { id: "private-test-reviewer-a" },
        reviewerB: { id: "private-test-reviewer-b" },
      },
      githubTarget: {
        owner: "private-test-owner",
        repository: "private-test-target",
      },
      discordOperator: { id: "private-test-discord-operator" },
    },
    policy: { reviewerDiversity: "distinct-serving-providers" },
    workers: {
      executionWorker: {
        secretReferences: [
          {
            purpose: "provider-authentication",
            provider: "environment",
            reference: "OPENAB_TEST_PROVIDER_SECRET",
            generation: "test-provider-generation-1",
          },
          {
            purpose: "acp-transport-authentication",
            provider: "environment",
            reference: "OPENAB_TEST_ACP_SECRET",
            generation: "test-acp-generation-1",
          },
        ],
      },
      githubPublisher: {
        secretReferences: [
          {
            purpose: "github-publication-authentication",
            provider: "environment",
            reference: "OPENAB_TEST_GITHUB_SECRET",
            generation: "test-github-generation-1",
          },
        ],
      },
      discordOperatorInterface: {
        secretReferences: [
          {
            purpose: "discord-bot-authentication",
            provider: "environment",
            reference: "OPENAB_TEST_DISCORD_SECRET",
            generation: "test-discord-generation-1",
          },
        ],
      },
    },
  };
}

test("preflight gives Runtime Core only a digest and secret generations", () => {
  const root = mkdtempSync(join(tmpdir(), "openab-preflight-"));
  try {
    for (const name of ["primary", "recovery", "workspaces"]) {
      mkdirSync(join(root, name));
    }
    const configPath = join(root, "installation.json");
    writeFileSync(configPath, JSON.stringify(privateInstallation(root)));

    const result = invoke([
      "preflight",
      "--config",
      configPath,
      "--product-root",
      repositoryRoot,
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const reply = JSON.parse(result.stdout);
    assert.equal(reply.synthetic, false);
    assert.deepEqual(reply.runtimeCore.secretReferenceGenerations, {
      "discord-operator-interface/discord-bot-authentication":
        "test-discord-generation-1",
      "execution-worker/acp-transport-authentication": "test-acp-generation-1",
      "execution-worker/provider-authentication": "test-provider-generation-1",
      "github-publisher/github-publication-authentication":
        "test-github-generation-1",
    });
    assert.doesNotMatch(result.stdout, /OPENAB_TEST_/);
    assert.doesNotMatch(result.stdout, /private-test-(operator|reviewer|target)/);
    assert.doesNotMatch(result.stdout, new RegExp(root));

    const installation = inspectInstallation(configPath, repositoryRoot);
    assert.deepEqual(
      installation.workerSecretResolutionPlan("github-publisher"),
      {
        configurationRevision: "private-test-v1",
        secretReferences: [
          {
            purpose: "github-publication-authentication",
            provider: "environment",
            reference: "OPENAB_TEST_GITHUB_SECRET",
            generation: "test-github-generation-1",
          },
        ],
      },
    );
    assert.throws(
      () => installation.workerSecretResolutionPlan("runtime-core"),
      /does not resolve Secret Material/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight rejects private storage or workspaces inside the Product Repository", () => {
  const root = mkdtempSync(join(tmpdir(), "openab-preflight-"));
  try {
    for (const name of ["primary", "recovery"]) {
      mkdirSync(join(root, name));
    }
    const configuration = privateInstallation(root);
    configuration.workspace.root.path = repositoryRoot;
    const configPath = join(root, "installation.json");
    writeFileSync(configPath, JSON.stringify(configuration));

    const result = invoke([
      "preflight",
      "--config",
      configPath,
      "--product-root",
      repositoryRoot,
    ]);
    assert.equal(result.exitCode, 2);
    assert.equal(JSON.parse(result.stderr).error.code, "PRIVATE_PATH_IN_CHECKOUT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight rejects primary and recovery roots that resolve to one location", () => {
  const root = mkdtempSync(join(tmpdir(), "openab-preflight-"));
  try {
    mkdirSync(join(root, "primary"));
    mkdirSync(join(root, "workspaces"));
    symlinkSync(join(root, "primary"), join(root, "recovery"));
    const configPath = join(root, "installation.json");
    writeFileSync(configPath, JSON.stringify(privateInstallation(root)));

    const result = invoke([
      "preflight",
      "--config",
      configPath,
      "--product-root",
      repositoryRoot,
    ]);
    assert.equal(result.exitCode, 2);
    assert.equal(
      JSON.parse(result.stderr).error.code,
      "STORAGE_ROOTS_NOT_DISTINCT",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight rejects Secret Material supplied as configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "openab-preflight-"));
  try {
    for (const name of ["primary", "recovery", "workspaces"]) {
      mkdirSync(join(root, name));
    }
    const configuration = privateInstallation(root);
    configuration.workers.executionWorker.secretReferences[0].value =
      "synthetic-inline-payload";
    const configPath = join(root, "installation.json");
    writeFileSync(configPath, JSON.stringify(configuration));

    const result = invoke([
      "preflight",
      "--config",
      configPath,
      "--product-root",
      repositoryRoot,
    ]);
    assert.equal(result.exitCode, 2);
    assert.equal(JSON.parse(result.stderr).error.code, "SECRET_PAYLOAD_FORBIDDEN");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight rejects incomplete authority-sensitive configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "openab-preflight-"));
  try {
    for (const name of ["primary", "recovery", "workspaces"]) {
      mkdirSync(join(root, name));
    }
    const configuration = privateInstallation(root);
    delete configuration.authority.agentRoleIdentities.reviewerB;
    const configPath = join(root, "installation.json");
    writeFileSync(configPath, JSON.stringify(configuration));

    const result = invoke([
      "preflight",
      "--config",
      configPath,
      "--product-root",
      repositoryRoot,
    ]);
    assert.equal(result.exitCode, 2);
    assert.equal(
      JSON.parse(result.stderr).error.code,
      "AUTHORITY_CONFIGURATION_INCOMPLETE",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synthetic preflight rejects private binding values", () => {
  const root = mkdtempSync(join(tmpdir(), "openab-preflight-"));
  try {
    const configuration = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "config/examples/synthetic-installation.json"),
        "utf8",
      ),
    );
    configuration.storage.primaryRoot = { path: root };
    const configPath = join(root, "synthetic-installation.json");
    writeFileSync(configPath, JSON.stringify(configuration));

    const result = invoke([
      "preflight",
      "--config",
      configPath,
      "--product-root",
      repositoryRoot,
    ]);
    assert.equal(result.exitCode, 2);
    assert.equal(
      JSON.parse(result.stderr).error.code,
      "SYNTHETIC_BINDINGS_FORBIDDEN",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight applies the fail-closed reviewer-diversity default", () => {
  const root = mkdtempSync(join(tmpdir(), "openab-preflight-"));
  try {
    const configuration = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "config/examples/synthetic-installation.json"),
        "utf8",
      ),
    );
    delete configuration.policy;
    const configPath = join(root, "synthetic-installation.json");
    writeFileSync(configPath, JSON.stringify(configuration));

    const result = invoke([
      "preflight",
      "--config",
      configPath,
      "--product-root",
      repositoryRoot,
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight rejects private Installation Configuration inside the checkout", () => {
  const privateRoot = mkdtempSync(join(tmpdir(), "openab-preflight-"));
  const configDirectory = resolve(repositoryRoot, ".tmp-preflight-test");
  try {
    for (const name of ["primary", "recovery", "workspaces"]) {
      mkdirSync(join(privateRoot, name));
    }
    mkdirSync(configDirectory);
    const configPath = join(configDirectory, "installation.json");
    writeFileSync(
      configPath,
      JSON.stringify(privateInstallation(privateRoot)),
    );

    const result = invoke([
      "preflight",
      "--config",
      configPath,
      "--product-root",
      repositoryRoot,
    ]);
    assert.equal(result.exitCode, 2);
    assert.equal(
      JSON.parse(result.stderr).error.code,
      "PRIVATE_CONFIGURATION_IN_CHECKOUT",
    );
  } finally {
    rmSync(privateRoot, { recursive: true, force: true });
    rmSync(configDirectory, { recursive: true, force: true });
  }
});
