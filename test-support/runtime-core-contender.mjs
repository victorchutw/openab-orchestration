import { parentPort, workerData } from "node:worker_threads";

import { openRuntimeCore } from "../src/runtime-core.mjs";

const signal = new Int32Array(workerData.signal);
const core = openRuntimeCore({
  primaryRoot: workerData.primaryRoot,
  recoveryRoot: workerData.recoveryRoot,
  operatorIdentity: "operator:test",
  orchestratorIdentity: "agent-role:orchestrator",
  planningExecutionProfile: {
    id: "profile:orchestrator-scripted-1",
    servingProvider: "scripted",
    model: "scripted-plan-v1",
    runtime: "in-memory",
  },
  executionProfiles: [
    {
      id: "profile:coding-primary",
      role: "coding",
      agentRoleIdentity: "agent-role:coding",
      servingProvider: "provider:coding",
    },
    {
      id: "profile:reviewer-a-primary",
      role: "reviewerA",
      agentRoleIdentity: "agent-role:reviewer-a",
      servingProvider: "provider:reviewer-a",
    },
    {
      id: "profile:reviewer-b-primary",
      role: "reviewerB",
      agentRoleIdentity: "agent-role:reviewer-b",
      servingProvider: "provider:reviewer-b",
    },
  ],
  configurationRevision: "configuration:test-1",
  effectiveConfigurationDigest: `sha256:${"a".repeat(64)}`,
  secretReferenceGenerations: {
    "execution-worker/provider-authentication": "generation:test-provider-1",
  },
  clock: () => "2026-08-13T00:00:00.000Z",
  identifiers: {
    offer: () => "offer:contended",
    run: () => "run:contender-a",
    commit: () => "commit:contender-a",
    effectIntent: () => "effect-intent:contender-a",
  },
});

parentPort.postMessage({ type: "ready" });
Atomics.wait(signal, 0, 0);

try {
  const reply = await core.operator(workerData.request);
  parentPort.postMessage({ type: "result", reply });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    error: { name: error.name, message: error.message, code: error.code },
  });
} finally {
  Atomics.store(signal, 0, 2);
  Atomics.notify(signal, 0);
  core.close();
}
