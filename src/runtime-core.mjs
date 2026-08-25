import {
  randomBytes as runtimeRandomBytes,
  randomUUID as runtimeRandomUUID,
} from "node:crypto";

import { requireNonEmptyString } from "./canonical.mjs";
import {
  authorizeOperatorRequest,
  createInitialOffer,
  createRejectionReceipt,
  executionRequestDigest,
  operatorRequestContent,
  operatorRequestDigest,
  projectOperatorReply,
  proposePlanningReport,
  proposeOperatorAction,
  validatePlanningReport,
} from "./core-model.mjs";
import { openDurability } from "./durability.mjs";

function runtimeNormalizeOptions(options) {
  for (const field of [
    "primaryRoot",
    "recoveryRoot",
    "operatorIdentity",
    "configurationRevision",
    "effectiveConfigurationDigest",
    "orchestratorIdentity",
  ]) {
    requireNonEmptyString(options?.[field], field);
  }
  if (
    options.planningExecutionProfile === null ||
    typeof options.planningExecutionProfile !== "object" ||
    Array.isArray(options.planningExecutionProfile)
  ) {
    throw new TypeError("planningExecutionProfile must be an object");
  }
  for (const field of ["id", "servingProvider", "model", "runtime"]) {
    requireNonEmptyString(
      options.planningExecutionProfile[field],
      `planningExecutionProfile.${field}`,
    );
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
    execution:
      options.identifiers?.execution ??
      (() => `execution:${runtimeRandomUUID()}`),
    directive:
      options.identifiers?.directive ??
      (() => `directive:${runtimeRandomBytes(32).toString("base64url")}`),
    operatorOffer:
      options.identifiers?.operatorOffer ??
      (() => `offer:${runtimeRandomBytes(32).toString("base64url")}`),
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

function runtimeDurablyRejectExecution(
  durability,
  options,
  request,
  requestDigest,
  rejection,
  conflictWithDigest,
) {
  const receipt = {
    status: "rejected",
    requestId: request.factId,
    actionKind: "ReportPlanningResult",
    cursor: structuredClone(durability.inspect().cursor),
    rejection: structuredClone(rejection),
    rejectedAt: options.clock(),
  };
  const durableReceipt = durability.reject({
    requestId: request.factId,
    requestDigest,
    requestContent: {
      kind: request.kind,
      agentRoleIdentity: request.agentRoleIdentity,
      factId: request.factId,
      directive: request.directive,
      result: structuredClone(request.result),
      evidence: structuredClone(request.evidence),
    },
    conflictWithDigest,
    receipt,
  });
  return { status: "rejected", rejection, receipt: durableReceipt };
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
            if (prior.pendingActivation !== undefined) {
              const activation = durability.resume({
                request,
                requestDigest,
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

        const generated = {
          acceptedAt: options.clock(),
        };
        if (request.action.kind === "SubmitObjective") {
          generated.runId = options.identifiers.run();
        }
        generated.commitId = options.identifiers.commit();
        if (
          request.action.kind === "SubmitObjective" ||
          request.action.kind === "RevisePlan" ||
          request.action.kind === "AbandonRun" ||
          request.action.kind === "CancelRun"
        ) {
          generated.effectIntentId = options.identifiers.effectIntent();
        }
        if (
          request.action.kind === "SubmitObjective" ||
          request.action.kind === "RevisePlan"
        ) {
          Object.assign(generated, {
            executionId: options.identifiers.execution(),
            directiveCapability: options.identifiers.directive(),
            orchestratorIdentity: options.orchestratorIdentity,
            planningExecutionProfile: options.planningExecutionProfile,
          });
        }
        if (request.action.kind === "SubmitObjective") {
          generated.operatorIdentity = options.operatorIdentity;
          generated.activeOperatorOffers = Array.from(
            { length: 2 },
            () => options.identifiers.operatorOffer(),
          );
        }
        const proposed = proposeOperatorAction(
          transaction.inspect(),
          request,
          generated,
        );
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

    async execution(request) {
      if (request?.kind === "Pull") {
        if (
          request === null ||
          typeof request !== "object" ||
          Array.isArray(request) ||
          Object.keys(request).some(
            (key) => !["kind", "agentRoleIdentity"].includes(key),
          )
        ) {
          throw new TypeError("execution Pull contains unsupported fields");
        }
        requireNonEmptyString(
          request.agentRoleIdentity,
          "agentRoleIdentity",
        );
        if (request.agentRoleIdentity !== options.orchestratorIdentity) {
          throw new Error(
            "agentRoleIdentity is not the configured Orchestrator Agent",
          );
        }
        if (durability.kind === "RecoveryRequired") {
          return { status: "unavailable", reason: "RecoveryRequired" };
        }
        const execution = durability.inspect().run?.planningExecution;
        const run = durability.inspect().run;
        if (run?.condition === "Cancelling") {
          return { status: "withheld", reason: "CancellationInProgress" };
        }
        if (execution?.status !== "Pending") {
          return { status: "idle" };
        }
        if (
          Date.parse(options.clock()) >=
          Date.parse(execution.directive.safetyLimit.expiresAt)
        ) {
          return {
            status: "expired",
            executionId: execution.id,
            completionEstablished: false,
          };
        }
        return {
          status: "offered",
          directive: structuredClone(execution.directive),
        };
      }
      if (request?.kind !== "Report") {
        throw new TypeError("execution request kind must be Pull or Report");
      }
      if (durability.kind === "RecoveryRequired") {
        return { status: "unavailable", reason: "RecoveryRequired" };
      }
      const observedAt = options.clock();
      return durability.act((transaction) => {
        const requestDigest = executionRequestDigest(request);
        const prior = transaction.receipt(request.factId, requestDigest);
        if (prior?.conflictWithDigest !== undefined) {
          const rejection = {
              code: "RequestIdConflict",
              message: "factId was already used with different content",
          };
          return runtimeDurablyRejectExecution(
            transaction,
            options,
            request,
            requestDigest,
            rejection,
            prior.conflictWithDigest,
          );
        }
        if (prior !== null) {
          return { status: "duplicate", receipt: prior.receipt };
        }
        const state = transaction.inspect();
        const rejection = validatePlanningReport(
          request,
          state,
          observedAt,
        );
        if (rejection !== null) {
          return runtimeDurablyRejectExecution(
            transaction,
            options,
            request,
            requestDigest,
            rejection,
          );
        }
        const proposed = proposePlanningReport(state, request, {
          acceptedAt: observedAt,
          commitId: options.identifiers.commit(),
          operatorIdentity: options.operatorIdentity,
          operatorOffers: Array.from(
            { length: 4 },
            () => options.identifiers.operatorOffer(),
          ),
        });
        const receipt = transaction.commit(proposed.candidate);
        return { status: "accepted", receipt };
      });
    },

    close() {
      durability.close();
    },
  };
}
