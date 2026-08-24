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
  if (
    options.secretReferenceGenerations === null ||
    typeof options.secretReferenceGenerations !== "object" ||
    Array.isArray(options.secretReferenceGenerations)
  ) {
    throw new TypeError("secretReferenceGenerations must be an object");
  }
  const identifiers = {
    offer:
      options.identifiers?.offer ??
      (() => `offer:${runtimeRandomBytes(32).toString("base64url")}`),
    restoreOffer:
      options.identifiers?.restoreOffer ??
      (() => `offer:${runtimeRandomBytes(32).toString("base64url")}`),
    postRestoreOffer:
      options.identifiers?.postRestoreOffer ??
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

function runtimeDurablyReject(
  durability,
  options,
  request,
  requestDigest,
  rejection,
  conflictWithDigest,
  projectReply = runtimeRejectedReply,
) {
  const receipt = createRejectionReceipt(
    durability.inspect(),
    request,
    rejection,
    options.clock(),
  );
  const durableReceipt = durability.reject({
    requestId: request.requestId,
    requestDigest,
    requestContent: operatorRequestContent(request),
    conflictWithDigest,
    receipt,
  });
  return projectReply(
    durability,
    request,
    rejection,
    durableReceipt,
  );
}

function runtimeRecoveryReply(state, request, recoveryOffer, result) {
  const recoveryPointIds = state.recovery.recoveryPoints.map(
    (point) => point.id,
  );
  return {
    ...result,
    cursor: structuredClone(state.cursor),
    view: {
      locale: request.locale,
      authorityEpoch: state.authorityEpoch,
      run: null,
      latestReceipt: null,
      recovery: structuredClone(state.recovery),
      copy:
        request.locale === "zh-TW"
          ? {
              status: "主要儲存已遺失，需要復原",
              nextAction:
                recoveryPointIds.length === 0
                  ? "等待 Operator 提供相符的設定與 Secret 參照世代"
                  : "選擇已驗證的復原點",
            }
          : {
              status: "Primary storage recovery is required",
              nextAction:
                recoveryPointIds.length === 0
                  ? "Wait for matching configuration and secret-reference generations"
                  : "Select a verified recovery point",
            },
    },
    offers:
      recoveryPointIds.length === 0
        ? []
        : [
            {
              kind: "Restore",
              offer: recoveryOffer,
              constraints: {
                recoveryPoint: {
                  type: "string",
                  enum: recoveryPointIds,
                },
              },
            },
          ],
  };
}

export function openRuntimeCore(rawOptions) {
  const options = runtimeNormalizeOptions(rawOptions);
  const initialOffer = createInitialOffer(
    options.identifiers.offer(),
    options.operatorIdentity,
  );
  const recoveryOffer = options.identifiers.restoreOffer();
  requireNonEmptyString(recoveryOffer, "identifiers.restoreOffer result");
  const postRestoreOffer = createInitialOffer(
    options.identifiers.postRestoreOffer(),
    options.operatorIdentity,
  );
  const durabilityOptions = {
    primaryRoot: options.primaryRoot,
    recoveryRoot: options.recoveryRoot,
    operatorIdentity: options.operatorIdentity,
    configurationRevision: options.configurationRevision,
    effectiveConfigurationDigest: options.effectiveConfigurationDigest,
    secretReferenceGenerations: options.secretReferenceGenerations,
    initialOffer,
  };
  let durability = openDurability(durabilityOptions);

  return {
    async operator(request) {
      authorizeOperatorRequest(request, options.operatorIdentity);
      if (durability.kind === "RecoveryRequired") {
        const state = durability.inspect();
        const projectRecoveryRejection = (
          recoveryDurability,
          recoveryRequest,
          rejection,
          receipt,
        ) =>
          runtimeRecoveryReply(
            recoveryDurability.inspect(),
            recoveryRequest,
            recoveryOffer,
            { status: "rejected", rejection, receipt },
          );
        if (request.kind === "Act") {
          const requestDigest = operatorRequestDigest(request);
          const prior = durability.receipt(request.requestId, requestDigest);
          if (prior !== null) {
            if (prior.conflictWithDigest !== undefined) {
              const rejection = {
                code: "RequestIdConflict",
                message: "requestId was already used with different content",
              };
              return runtimeDurablyReject(
                durability,
                options,
                request,
                requestDigest,
                rejection,
                prior.conflictWithDigest,
                projectRecoveryRejection,
              );
            }
            return runtimeRecoveryReply(
              state,
              request,
              recoveryOffer,
              { status: "duplicate", receipt: prior.receipt },
            );
          }

          let rejection;
          if (request.offer !== recoveryOffer) {
            rejection = {
              code: "MismatchedOffer",
              message: "offer is not recognized for primary recovery",
            };
          } else if (request.action.kind !== "Restore") {
            rejection = {
              code: "ActionNotOffered",
              message: "only Restore is offered while primary recovery is required",
            };
          } else if (
            !state.recovery.recoveryPoints.some(
              (point) => point.id === request.action.payload.recoveryPoint,
            )
          ) {
            rejection = {
              code: "MismatchedOffer",
              message: "recovery point is not verified and offered",
            };
          }
          if (rejection !== undefined) {
            return runtimeDurablyReject(
              durability,
              options,
              request,
              requestDigest,
              rejection,
              undefined,
              projectRecoveryRejection,
            );
          }

          const activation = durability.restore({
            request,
            requestDigest,
            recoveryPointId: request.action.payload.recoveryPoint,
            restoredAt: options.clock(),
            replacementOffer: postRestoreOffer,
          });
          durability.close();
          durability = openDurability(durabilityOptions);
          return projectOperatorReply(
            activation.state,
            request.principal,
            request.locale,
            { status: "accepted", receipt: activation.receipt },
          );
        }
        return runtimeRecoveryReply(
          state,
          request,
          recoveryOffer,
          { status: "observed" },
        );
      }
      if (request.kind === "Observe") {
        return projectOperatorReply(
          durability.inspect(),
          request.principal,
          request.locale,
          { status: "observed" },
        );
      }

      return durability.act((transaction) => {
        const contentDigest = operatorRequestDigest(request);
        const prior = transaction.receipt(request.requestId, contentDigest);
        if (prior !== null) {
          if (prior.conflictWithDigest !== undefined) {
            const rejection = {
              code: "RequestIdConflict",
              message: "requestId was already used with different content",
            };
            return runtimeDurablyReject(
              transaction,
              options,
              request,
              contentDigest,
              rejection,
              prior.conflictWithDigest,
            );
          }
          return projectOperatorReply(
            transaction.inspect(),
            request.principal,
            request.locale,
            { status: "duplicate", receipt: prior.receipt },
          );
        }

        const proposed = proposeOperatorAction(transaction.inspect(), request, {
          acceptedAt: options.clock(),
          runId: options.identifiers.run(),
          commitId: options.identifiers.commit(),
          effectIntentId: options.identifiers.effectIntent(),
        });
        if (proposed.rejection !== undefined) {
          return runtimeDurablyReject(
            transaction,
            options,
            request,
            contentDigest,
            proposed.rejection,
          );
        }
        const receipt = transaction.commit(proposed.candidate);
        return projectOperatorReply(
          transaction.inspect(),
          request.principal,
          request.locale,
          { status: "accepted", receipt },
        );
      });
    },

    close() {
      durability.close();
    },
  };
}
