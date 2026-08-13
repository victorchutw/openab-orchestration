import {
  randomBytes as runtimeRandomBytes,
  randomUUID as runtimeRandomUUID,
} from "node:crypto";

import { requireNonEmptyString } from "./canonical.mjs";
import {
  authorizeOperatorRequest,
  createInitialOffer,
  createRejectionReceipt,
  operatorRequestContent,
  operatorRequestDigest,
  projectOperatorReply,
  proposeOperatorAction,
} from "./core-model.mjs";
import { openDurability } from "./durability.mjs";

function runtimeNormalizeOptions(options) {
  for (const field of [
    "primaryRoot",
    "recoveryRoot",
    "operatorIdentity",
    "configurationRevision",
    "effectiveConfigurationDigest",
  ]) {
    requireNonEmptyString(options?.[field], field);
  }
  const identifiers = {
    offer:
      options.identifiers?.offer ??
      (() => `offer:${runtimeRandomBytes(32).toString("base64url")}`),
    run: options.identifiers?.run ?? (() => `run:${runtimeRandomUUID()}`),
    commit:
      options.identifiers?.commit ?? (() => `commit:${runtimeRandomUUID()}`),
    effectIntent:
      options.identifiers?.effectIntent ??
      (() => `effect-intent:${runtimeRandomUUID()}`),
  };
  for (const [kind, generator] of Object.entries(identifiers)) {
    if (typeof generator !== "function") {
      throw new TypeError(`identifiers.${kind} must be a function`);
    }
  }
  if (options.clock !== undefined && typeof options.clock !== "function") {
    throw new TypeError("clock must be a function");
  }
  return {
    ...options,
    identifiers,
    clock: options.clock ?? (() => new Date().toISOString()),
  };
}

function runtimeRejectedReply(durability, request, rejection, receipt) {
  return projectOperatorReply(
    durability.inspect(),
    request.principal,
    request.locale,
    { status: "rejected", rejection, receipt },
  );
}

export function openRuntimeCore(rawOptions) {
  const options = runtimeNormalizeOptions(rawOptions);
  const durability = openDurability({
    primaryRoot: options.primaryRoot,
    recoveryRoot: options.recoveryRoot,
    operatorIdentity: options.operatorIdentity,
    configurationRevision: options.configurationRevision,
    effectiveConfigurationDigest: options.effectiveConfigurationDigest,
    initialOffer: createInitialOffer(
      options.identifiers.offer(),
      options.operatorIdentity,
    ),
  });

  return {
    async operator(request) {
      authorizeOperatorRequest(request, options.operatorIdentity);
      if (request.kind === "Observe") {
        return projectOperatorReply(
          durability.inspect(),
          request.principal,
          request.locale,
          { status: "observed" },
        );
      }

      const contentDigest = operatorRequestDigest(request);
      const prior = durability.receipt(request.requestId, contentDigest);
      if (prior !== null) {
        if (prior.conflictWithDigest !== undefined) {
          const rejection = {
            code: "RequestIdConflict",
            message: "requestId was already used with different content",
          };
          const state = durability.inspect();
          const receipt = createRejectionReceipt(
            state,
            request,
            rejection,
            options.clock(),
          );
          const durableReceipt = durability.reject({
            requestId: request.requestId,
            requestDigest: contentDigest,
            requestContent: operatorRequestContent(request),
            conflictWithDigest: prior.conflictWithDigest,
            receipt,
          });
          return runtimeRejectedReply(
            durability,
            request,
            rejection,
            durableReceipt,
          );
        }
        return projectOperatorReply(
          durability.inspect(),
          request.principal,
          request.locale,
          { status: "duplicate", receipt: prior.receipt },
        );
      }

      const proposed = proposeOperatorAction(durability.inspect(), request, {
        acceptedAt: options.clock(),
        runId: options.identifiers.run(),
        commitId: options.identifiers.commit(),
        effectIntentId: options.identifiers.effectIntent(),
      });
      if (proposed.rejection !== undefined) {
        const state = durability.inspect();
        const receipt = createRejectionReceipt(
          state,
          request,
          proposed.rejection,
          options.clock(),
        );
        const durableReceipt = durability.reject({
          requestId: request.requestId,
          requestDigest: contentDigest,
          requestContent: operatorRequestContent(request),
          receipt,
        });
        return runtimeRejectedReply(
          durability,
          request,
          proposed.rejection,
          durableReceipt,
        );
      }
      const receipt = durability.commit(proposed.candidate);
      return projectOperatorReply(
        durability.inspect(),
        request.principal,
        request.locale,
        { status: "accepted", receipt },
      );
    },

    close() {
      durability.close();
    },
  };
}
