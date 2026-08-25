import { canonicalDigest, requireNonEmptyString } from "./canonical.mjs";

export const SUBMIT_OBJECTIVE = "SubmitObjective";
export const RESTORE = "Restore";
export const REPORT_PLANNING_RESULT = "ReportPlanningResult";
export const CONFIRM_PLAN = "ConfirmPlan";
export const REVISE_PLAN = "RevisePlan";
export const ABANDON_RUN = "AbandonRun";
export const CANCEL_RUN = "CancelRun";
export const SUBMIT_OBJECTIVE_CONSTRAINTS = Object.freeze({
  objective: Object.freeze({
    type: "string",
    minLength: 1,
    maxLength: 4096,
  }),
});

const CORE_OPERATOR_COPY = Object.freeze({
  en: Object.freeze({
    idleStatus: "No active Run",
    idleNextAction: "Submit an objective",
    planningStatus: "Run is active in Planning",
    planningNextAction: "Await the Orchestrator Agent's Run Plan",
    planningWaitingStatus: "Run Plan awaits Operator confirmation",
    planningWaitingNextAction: "Confirm, revise, abandon, or cancel the Run",
    codingStatus: "Confirmed Run is active in Coding",
    codingNextAction: "Await the Coding Agent",
    cancellingStatus: "Run cancellation is converging",
    cancellingNextAction: "Await stopping or isolation evidence",
    abandonedStatus: "Run was Abandoned",
    cancelledStatus: "Run was Cancelled",
    terminalNextAction: "No further action is legal for this Run",
    reconciliationStatus: "Run restoration requires Reconciliation",
    reconciliationNextAction:
      "Reconcile active or uncertain effects before continuing",
  }),
  "zh-TW": Object.freeze({
    idleStatus: "沒有進行中的 Run",
    idleNextAction: "提交目標",
    planningStatus: "Run 正在 Planning 階段進行",
    planningNextAction: "等待 Orchestrator Agent 提出 Run Plan",
    planningWaitingStatus: "Run Plan 等待 Operator 確認",
    planningWaitingNextAction: "確認、修訂、放棄或取消 Run",
    codingStatus: "已確認的 Run 正在 Coding 階段進行",
    codingNextAction: "等待 Coding Agent",
    cancellingStatus: "Run 正在收斂取消狀態",
    cancellingNextAction: "等待停止或隔離證據",
    abandonedStatus: "Run 已放棄",
    cancelledStatus: "Run 已取消",
    terminalNextAction: "此 Run 已無合法動作",
    reconciliationStatus: "Run 復原後需要進行 Reconciliation",
    reconciliationNextAction: "先調和查證進行中或結果不確定的外部效果",
  }),
});

const PLANNING_OPERATOR_ACTIONS = Object.freeze({
  [ABANDON_RUN]: Object.freeze({
    reason: Object.freeze({ type: "string", minLength: 1, maxLength: 4096 }),
  }),
  [CANCEL_RUN]: Object.freeze({}),
  [CONFIRM_PLAN]: Object.freeze({}),
  [REVISE_PLAN]: Object.freeze({
    guidance: Object.freeze({ type: "string", minLength: 1, maxLength: 4096 }),
  }),
});

function coreRequireOnlyKeys(value, allowedKeys, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const unexpected = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unexpected.length > 0) {
    throw new TypeError(
      `${field} contains unsupported fields: ${unexpected.join(", ")}`,
    );
  }
}

function coreRequireLocale(locale) {
  if (!Object.hasOwn(CORE_OPERATOR_COPY, locale)) {
    throw new TypeError("locale must be en or zh-TW");
  }
}

function coreValidateObserve(request) {
  coreRequireOnlyKeys(
    request,
    ["kind", "principal", "locale"],
    "Observe request",
  );
}

function coreValidateAct(request) {
  coreRequireOnlyKeys(
    request,
    ["kind", "principal", "locale", "requestId", "offer", "action"],
    "Act request",
  );
  requireNonEmptyString(request.requestId, "requestId");
  requireNonEmptyString(request.offer, "offer");
  coreRequireOnlyKeys(request.action, ["kind", "payload"], "action");
  if (request.action.kind === SUBMIT_OBJECTIVE) {
    coreRequireOnlyKeys(
      request.action.payload,
      ["objective"],
      "action.payload",
    );
    const objective = request.action.payload.objective;
    if (
      typeof objective !== "string" ||
      objective.length < SUBMIT_OBJECTIVE_CONSTRAINTS.objective.minLength ||
      objective.length > SUBMIT_OBJECTIVE_CONSTRAINTS.objective.maxLength
    ) {
      throw new TypeError("objective must contain between 1 and 4096 characters");
    }
    return;
  }
  if (request.action.kind === RESTORE) {
    coreRequireOnlyKeys(
      request.action.payload,
      ["recoveryPoint"],
      "action.payload",
    );
    requireNonEmptyString(
      request.action.payload.recoveryPoint,
      "action.payload.recoveryPoint",
    );
    return;
  }
  if (request.action.kind === REVISE_PLAN) {
    coreRequireOnlyKeys(
      request.action.payload,
      ["guidance"],
      "action.payload",
    );
    const guidance = request.action.payload.guidance;
    if (
      typeof guidance !== "string" ||
      guidance.length < 1 ||
      guidance.length > 4096
    ) {
      throw new TypeError("guidance must contain between 1 and 4096 characters");
    }
    return;
  }
  if (
    request.action.kind === CONFIRM_PLAN ||
    request.action.kind === CANCEL_RUN
  ) {
    coreRequireOnlyKeys(request.action.payload, [], "action.payload");
    return;
  }
  if (request.action.kind === ABANDON_RUN) {
    coreRequireOnlyKeys(request.action.payload, ["reason"], "action.payload");
    const reason = request.action.payload.reason;
    if (
      typeof reason !== "string" ||
      reason.length < 1 ||
      reason.length > 4096
    ) {
      throw new TypeError("reason must contain between 1 and 4096 characters");
    }
    return;
  }
  throw new TypeError(
    "action.kind is not supported by the Runtime Core",
  );
}

export function authorizeOperatorRequest(request, operatorIdentity) {
  requireNonEmptyString(request?.principal, "principal");
  if (request.principal !== operatorIdentity) {
    throw new Error("principal is not the authenticated Operator");
  }
  coreRequireLocale(request.locale);
  if (request.kind === "Observe") {
    coreValidateObserve(request);
    return;
  }
  if (request.kind === "Act") {
    coreValidateAct(request);
    return;
  }
  throw new TypeError("operator request kind must be Observe or Act");
}

export function createInitialOffer(offer, principal, authorityEpoch = 1) {
  requireNonEmptyString(offer, "identifiers.offer result");
  return {
    offer,
    principal,
    revision: 0,
    authorityEpoch,
    actionKind: SUBMIT_OBJECTIVE,
    constraints: SUBMIT_OBJECTIVE_CONSTRAINTS,
    consumedRevision: null,
  };
}

export function operatorRequestDigest(request) {
  return canonicalDigest(operatorRequestContent(request));
}

export function operatorRequestContent(request) {
  return {
    principal: request.principal,
    offer: request.offer,
    action: structuredClone(request.action),
  };
}

export function executionRequestContent(request) {
  return {
    kind: request.kind,
    agentRoleIdentity: request.agentRoleIdentity,
    factId: request.factId,
    directive: request.directive,
    result: structuredClone(request.result),
    evidence: structuredClone(request.evidence),
  };
}

export function executionRequestDigest(request) {
  return canonicalDigest(executionRequestContent(request));
}

function coreRequireNonEmptyStringArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty array`);
  }
  const seen = new Set();
  for (const item of value) {
    requireNonEmptyString(item, `${field} item`);
    if (seen.has(item)) {
      throw new TypeError(`${field} must not contain duplicates`);
    }
    seen.add(item);
  }
}

function coreValidateExecutionProfiles(runPlan) {
  const roles = ["coding", "reviewerA", "reviewerB"];
  coreRequireOnlyKeys(
    runPlan.eligibleExecutionProfiles,
    roles,
    "result.runPlan.eligibleExecutionProfiles",
  );
  coreRequireOnlyKeys(
    runPlan.fallbackOrder,
    roles,
    "result.runPlan.fallbackOrder",
  );
  for (const role of roles) {
    coreRequireNonEmptyStringArray(
      runPlan.eligibleExecutionProfiles[role],
      `result.runPlan.eligibleExecutionProfiles.${role}`,
    );
    coreRequireNonEmptyStringArray(
      runPlan.fallbackOrder[role],
      `result.runPlan.fallbackOrder.${role}`,
    );
    if (
      canonicalDigest([...runPlan.eligibleExecutionProfiles[role]].sort()) !==
      canonicalDigest([...runPlan.fallbackOrder[role]].sort())
    ) {
      throw new TypeError(
        `result.runPlan.fallbackOrder.${role} must order every eligible profile exactly once`,
      );
    }
  }
}

export function validatePlanningReport(request, state, observedAt) {
  coreRequireOnlyKeys(
    request,
    [
      "kind",
      "agentRoleIdentity",
      "factId",
      "directive",
      "result",
      "evidence",
    ],
    "Report request",
  );
  requireNonEmptyString(request.agentRoleIdentity, "agentRoleIdentity");
  requireNonEmptyString(request.factId, "factId");
  requireNonEmptyString(request.directive, "directive");
  requireNonEmptyString(observedAt, "clock result");
  const execution = state.run?.planningExecution;
  if (
    state.run?.stage !== "Planning" ||
    state.run.condition !== "Active" ||
    execution?.status !== "Pending"
  ) {
    return {
      code: "ExecutionNotPending",
      message: "the Planning Execution is not pending",
    };
  }
  const directive = execution.directive;
  if (
    request.agentRoleIdentity !== directive.agentRoleIdentity ||
    request.directive !== directive.capability
  ) {
    return {
      code: "MismatchedDirective",
      message: "Report is not bound to the pending Planning directive",
    };
  }
  if (Date.parse(observedAt) >= Date.parse(directive.safetyLimit.expiresAt)) {
    return {
      code: "SafetyLimitExpired",
      message: "Planning safety limit expired before a valid result was observed",
    };
  }

  const result = request.result;
  coreRequireOnlyKeys(
    result,
    [
      "format",
      "executionId",
      "planRevision",
      "agentRoleIdentity",
      "executionProfileId",
      "outcome",
      "runPlan",
    ],
    "result",
  );
  if (
    result.format !== "openab.planning-execution-result/v1" ||
    result.outcome !== "Succeeded" ||
    result.executionId !== directive.executionId ||
    result.planRevision !== directive.planRevision ||
    result.agentRoleIdentity !== directive.agentRoleIdentity ||
    result.executionProfileId !== directive.executionProfile.id
  ) {
    return {
      code: "InvalidExecutionResult",
      message: "Planning Execution Result does not match the directive",
    };
  }
  const runPlan = result.runPlan;
  coreRequireOnlyKeys(
    runPlan,
    [
      "objective",
      "scope",
      "acceptanceBoundary",
      "evidenceRequirements",
      "remediationAllowance",
      "eligibleExecutionProfiles",
      "fallbackOrder",
      "reviewerDiversityMode",
    ],
    "result.runPlan",
  );
  requireNonEmptyString(runPlan.objective, "result.runPlan.objective");
  for (const field of ["scope", "acceptanceBoundary", "evidenceRequirements"]) {
    coreRequireNonEmptyStringArray(runPlan[field], `result.runPlan.${field}`);
  }
  coreRequireOnlyKeys(
    runPlan.remediationAllowance,
    ["maximumRounds"],
    "result.runPlan.remediationAllowance",
  );
  if (runPlan.remediationAllowance.maximumRounds !== 1) {
    throw new TypeError(
      "result.runPlan.remediationAllowance.maximumRounds must be 1",
    );
  }
  coreValidateExecutionProfiles(runPlan);
  if (runPlan.reviewerDiversityMode !== "distinct-serving-providers") {
    throw new TypeError(
      "result.runPlan.reviewerDiversityMode must be distinct-serving-providers",
    );
  }
  if (!Array.isArray(request.evidence) || request.evidence.length === 0) {
    return {
      code: "InvalidVerificationEvidence",
      message: "Planning Report requires Verification Evidence",
    };
  }
  const expectedResultDigest = canonicalDigest(result);
  for (const evidence of request.evidence) {
    coreRequireOnlyKeys(
      evidence,
      ["format", "kind", "resultDigest"],
      "evidence item",
    );
    if (
      evidence.format !== "openab.verification-evidence/v1" ||
      evidence.kind !== "ScriptedPlanningResult" ||
      evidence.resultDigest !== expectedResultDigest
    ) {
      return {
        code: "InvalidVerificationEvidence",
        message: "Verification Evidence does not attest the reported result",
      };
    }
  }
  return null;
}

export function proposePlanningReport(state, request, generated) {
  for (const field of ["acceptedAt", "commitId", "operatorIdentity"]) {
    requireNonEmptyString(generated[field], field);
  }
  if (!Array.isArray(generated.operatorOffers)) {
    throw new TypeError("operatorOffers must be an array");
  }
  const revision = state.cursor.revision + 1;
  const operatorOffers = Object.entries(PLANNING_OPERATOR_ACTIONS).map(
    ([actionKind, constraints], index) => ({
      offer: generated.operatorOffers[index],
      principal: generated.operatorIdentity,
      revision,
      authorityEpoch: state.authorityEpoch,
      actionKind,
      constraints,
      consumedRevision: null,
    }),
  );
  for (const offer of operatorOffers) {
    requireNonEmptyString(offer.offer, "operator offer");
  }
  const run = structuredClone(state.run);
  run.condition = "Waiting for Operator";
  run.plan = structuredClone(request.result.runPlan);
  run.lastCommittedTransition = REPORT_PLANNING_RESULT;
  run.planningExecution = {
    ...run.planningExecution,
    status: "Completed",
    completedAt: generated.acceptedAt,
    result: structuredClone(request.result),
    evidence: structuredClone(request.evidence),
  };
  const receipt = {
    status: "accepted",
    requestId: request.factId,
    commitId: generated.commitId,
    revision,
    actionKind: REPORT_PLANNING_RESULT,
    runId: run.id,
    acceptedAt: generated.acceptedAt,
  };
  return {
    candidate: {
      commitId: generated.commitId,
      predecessor: state.cursor.commitId,
      revision,
      requestId: request.factId,
      requestDigest: executionRequestDigest(request),
      requestContent: executionRequestContent(request),
      receipt,
      run,
      createsRun: false,
      consumedOffer: null,
      createdOffers: operatorOffers,
      offerConstraintsDigest: null,
      authorization: {
        kind: "ExecutionDirective",
        agentRoleIdentity: request.agentRoleIdentity,
        capability: request.directive,
        executionId: state.run.planningExecution.id,
        executionProfileDigest: canonicalDigest(
          state.run.planningExecution.directive.executionProfile,
        ),
        executionContextDigest: canonicalDigest(
          state.run.planningExecution.directive.executionContext,
        ),
        effectIntentId:
          state.run.planningExecution.directive.effectIntent.id,
      },
      audit: {
        actionKind: REPORT_PLANNING_RESULT,
        principal: request.agentRoleIdentity,
        runId: run.id,
        executionId: state.run.planningExecution.id,
        recordedAt: generated.acceptedAt,
      },
      effectIntents: [],
      artifacts: [],
    },
  };
}

export function createRejectionReceipt(state, request, rejection, rejectedAt) {
  requireNonEmptyString(rejectedAt, "clock result");
  return {
    status: "rejected",
    requestId: request.requestId,
    actionKind: request.action.kind,
    cursor: structuredClone(state.cursor),
    rejection: structuredClone(rejection),
    rejectedAt,
  };
}

export function proposeOperatorAction(state, request, generated) {
  if (request.action.kind === RESTORE) {
    return {
      rejection: {
        code: "ActionNotOffered",
        message: "Restore is offered only while primary recovery is required",
      },
    };
  }
  const offer = state.offers.find(
    (candidate) => candidate.offer === request.offer,
  );
  if (offer === undefined) {
    return {
      rejection: {
        code: "MismatchedOffer",
        message: "offer is not recognized by this Runtime Core",
      },
    };
  }
  if (
    request.action.kind === REVISE_PLAN &&
    state.run?.confirmedPlan !== null
  ) {
    return {
      rejection: {
        code: "SuccessorRunRequired",
        message:
          "a confirmed objective, scope, or acceptance-boundary change requires a Successor Run",
      },
    };
  }
  if (
    offer.consumedRevision !== null ||
    offer.revision !== state.cursor.revision
  ) {
    return {
      rejection: {
        code: "StaleOffer",
        message: "offer is no longer valid at the current cursor",
      },
    };
  }
  if (
    offer.principal !== request.principal ||
    offer.authorityEpoch !== state.authorityEpoch ||
    offer.actionKind !== request.action.kind ||
    canonicalDigest(offer.constraints) !== canonicalDigest(
      request.action.kind === SUBMIT_OBJECTIVE
        ? SUBMIT_OBJECTIVE_CONSTRAINTS
        : PLANNING_OPERATOR_ACTIONS[request.action.kind],
    )
  ) {
    return {
      rejection: {
        code: "MismatchedOffer",
        message: "offer is not bound to this principal, action, and constraints",
      },
    };
  }
  if (request.action.kind === REVISE_PLAN) {
    if (
      state.run?.stage !== "Planning" ||
      state.run.condition !== "Waiting for Operator" ||
      state.run.plan === null ||
      state.run.confirmedPlan !== null
    ) {
      return {
        rejection: {
          code: "ActionNotOffered",
          message: "Run Plan revision is not legal in the current state",
        },
      };
    }
    for (const field of [
      "acceptedAt",
      "commitId",
      "effectIntentId",
      "executionId",
      "directiveCapability",
      "orchestratorIdentity",
    ]) {
      requireNonEmptyString(generated[field], field);
    }
    const startedAt = new Date(generated.acceptedAt);
    if (Number.isNaN(startedAt.valueOf())) {
      throw new TypeError("acceptedAt must be an ISO timestamp");
    }
    const planRevision = state.run.planRevision + 1;
    const revision = state.cursor.revision + 1;
    const run = structuredClone(state.run);
    run.condition = "Active";
    run.planRevision = planRevision;
    run.lastCommittedTransition = REVISE_PLAN;
    run.planningExecution = {
      id: generated.executionId,
      status: "Pending",
      replacementUsed: false,
      directive: {
        format: "openab.execution-directive/v1",
        capability: generated.directiveCapability,
        executionId: generated.executionId,
        runId: run.id,
        planRevision,
        agentRoleIdentity: generated.orchestratorIdentity,
        executionProfile: structuredClone(generated.planningExecutionProfile),
        executionContext: {
          format: "openab.execution-context/v1",
          runId: run.id,
          objective: run.plan.objective,
          planRevision,
          priorPlan: structuredClone(run.plan),
          revisionGuidance: request.action.payload.guidance,
        },
        effectIntent: {
          id: generated.effectIntentId,
          kind: "StartPlanningExecution",
        },
        authorityEpoch: state.authorityEpoch,
        deliveryGeneration: 1,
        safetyLimit: {
          durationMs: 600_000,
          startedAt: generated.acceptedAt,
          expiresAt: new Date(
            startedAt.valueOf() + 10 * 60 * 1_000,
          ).toISOString(),
        },
      },
    };
    const receipt = {
      status: "accepted",
      requestId: request.requestId,
      commitId: generated.commitId,
      revision,
      actionKind: REVISE_PLAN,
      runId: run.id,
      acceptedAt: generated.acceptedAt,
    };
    return {
      candidate: {
        commitId: generated.commitId,
        predecessor: state.cursor.commitId,
        revision,
        requestId: request.requestId,
        requestDigest: operatorRequestDigest(request),
        requestContent: operatorRequestContent(request),
        receipt,
        run,
        createsRun: false,
        consumedOffer: request.offer,
        createdOffers: [],
        offerConstraintsDigest: canonicalDigest(offer.constraints),
        audit: {
          actionKind: REVISE_PLAN,
          principal: request.principal,
          runId: run.id,
          planRevision,
          recordedAt: generated.acceptedAt,
        },
        effectIntents: [
          {
            id: generated.effectIntentId,
            kind: "StartPlanningExecution",
            disposition: "Pending",
          },
        ],
        artifacts: [],
      },
    };
  }
  if (request.action.kind === CONFIRM_PLAN) {
    if (
      state.run?.stage !== "Planning" ||
      state.run.condition !== "Waiting for Operator" ||
      state.run.plan === null ||
      state.run.confirmedPlan !== null ||
      state.run.planningExecution?.status !== "Completed"
    ) {
      return {
        rejection: {
          code: "ActionNotOffered",
          message: "Run Plan confirmation is not legal in the current state",
        },
      };
    }
    for (const field of ["acceptedAt", "commitId"]) {
      requireNonEmptyString(generated[field], field);
    }
    const revision = state.cursor.revision + 1;
    const run = structuredClone(state.run);
    run.objective = run.plan.objective;
    run.stage = "Coding";
    run.condition = "Active";
    run.lastCommittedTransition = CONFIRM_PLAN;
    run.confirmedPlan = {
      format: "openab.run-plan/v1",
      planRevision: run.planRevision,
      confirmedAt: generated.acceptedAt,
      ...structuredClone(run.plan),
    };
    const receipt = {
      status: "accepted",
      requestId: request.requestId,
      commitId: generated.commitId,
      revision,
      actionKind: CONFIRM_PLAN,
      runId: run.id,
      acceptedAt: generated.acceptedAt,
    };
    return {
      candidate: {
        commitId: generated.commitId,
        predecessor: state.cursor.commitId,
        revision,
        requestId: request.requestId,
        requestDigest: operatorRequestDigest(request),
        requestContent: operatorRequestContent(request),
        receipt,
        run,
        createsRun: false,
        consumedOffer: request.offer,
        createdOffers: [],
        offerConstraintsDigest: canonicalDigest(offer.constraints),
        audit: {
          actionKind: CONFIRM_PLAN,
          principal: request.principal,
          runId: run.id,
          planRevision: run.planRevision,
          recordedAt: generated.acceptedAt,
        },
        effectIntents: [],
        artifacts: [],
      },
    };
  }
  if (
    request.action.kind === ABANDON_RUN ||
    request.action.kind === CANCEL_RUN
  ) {
    if (state.run === null || state.run.condition === "Terminal") {
      return {
        rejection: {
          code: "ActionNotOffered",
          message: "the Run cannot be stopped in the current state",
        },
      };
    }
    for (const field of ["acceptedAt", "commitId"]) {
      requireNonEmptyString(generated[field], field);
    }
    const activeExecution =
      state.run.planningExecution?.status === "Pending";
    if (activeExecution) {
      requireNonEmptyString(generated.effectIntentId, "effectIntentId");
    }
    const revision = state.cursor.revision + 1;
    const run = structuredClone(state.run);
    run.lastCommittedTransition = request.action.kind;
    if (request.action.kind === ABANDON_RUN) {
      run.abandonmentReason = request.action.payload.reason;
    }
    if (activeExecution) {
      run.condition = "Cancelling";
      run.abandonAfterCancellation = request.action.kind === ABANDON_RUN;
      run.cancellationRequestedAt = generated.acceptedAt;
    } else {
      run.condition = "Terminal";
      run.outcome =
        request.action.kind === ABANDON_RUN ? "Abandoned" : "Cancelled";
      run.completedAt = generated.acceptedAt;
    }
    const receipt = {
      status: "accepted",
      requestId: request.requestId,
      commitId: generated.commitId,
      revision,
      actionKind: request.action.kind,
      runId: run.id,
      acceptedAt: generated.acceptedAt,
    };
    return {
      candidate: {
        commitId: generated.commitId,
        predecessor: state.cursor.commitId,
        revision,
        requestId: request.requestId,
        requestDigest: operatorRequestDigest(request),
        requestContent: operatorRequestContent(request),
        receipt,
        run,
        createsRun: false,
        consumedOffer: request.offer,
        createdOffers: [],
        offerConstraintsDigest: canonicalDigest(offer.constraints),
        audit: {
          actionKind: request.action.kind,
          principal: request.principal,
          runId: run.id,
          recordedAt: generated.acceptedAt,
        },
        effectIntents: activeExecution
          ? [
              {
                id: generated.effectIntentId,
                kind: "CancelPlanningExecution",
                disposition: "Pending",
              },
            ]
          : [],
        artifacts: [],
      },
    };
  }
  if (state.run !== null) {
    return {
      rejection: {
        code: "ActionNotOffered",
        message: "a second objective is not offered while a Run is non-terminal",
      },
    };
  }

  for (const field of [
    "acceptedAt",
    "runId",
    "commitId",
    "effectIntentId",
    "executionId",
    "directiveCapability",
    "orchestratorIdentity",
    "operatorIdentity",
  ]) {
    requireNonEmptyString(generated[field], field);
  }
  const startedAt = new Date(generated.acceptedAt);
  if (Number.isNaN(startedAt.valueOf())) {
    throw new TypeError("acceptedAt must be an ISO timestamp");
  }
  const expiresAt = new Date(
    startedAt.valueOf() + 10 * 60 * 1_000,
  ).toISOString();
  const revision = state.cursor.revision + 1;
  if (!Array.isArray(generated.activeOperatorOffers)) {
    throw new TypeError("activeOperatorOffers must be an array");
  }
  const createdOffers = [ABANDON_RUN, CANCEL_RUN].map(
    (actionKind, index) => {
      const createdOffer = generated.activeOperatorOffers[index];
      requireNonEmptyString(createdOffer, "active Operator offer");
      return {
        offer: createdOffer,
        principal: generated.operatorIdentity,
        revision,
        authorityEpoch: state.authorityEpoch,
        actionKind,
        constraints: PLANNING_OPERATOR_ACTIONS[actionKind],
        consumedRevision: null,
      };
    },
  );
  const run = {
    id: generated.runId,
    objective: request.action.payload.objective,
    stage: "Planning",
    condition: "Active",
    reviewRound: null,
    outcome: null,
    createdAt: generated.acceptedAt,
    planRevision: 1,
    plan: null,
    confirmedPlan: null,
    lastCommittedTransition: SUBMIT_OBJECTIVE,
    planningExecution: {
      id: generated.executionId,
      status: "Pending",
      replacementUsed: false,
      directive: {
        format: "openab.execution-directive/v1",
        capability: generated.directiveCapability,
        executionId: generated.executionId,
        runId: generated.runId,
        planRevision: 1,
        agentRoleIdentity: generated.orchestratorIdentity,
        executionProfile: structuredClone(generated.planningExecutionProfile),
        executionContext: {
          format: "openab.execution-context/v1",
          runId: generated.runId,
          objective: request.action.payload.objective,
          planRevision: 1,
          priorPlan: null,
          revisionGuidance: null,
        },
        effectIntent: {
          id: generated.effectIntentId,
          kind: "StartPlanningExecution",
        },
        authorityEpoch: state.authorityEpoch,
        deliveryGeneration: 1,
        safetyLimit: {
          durationMs: 600_000,
          startedAt: generated.acceptedAt,
          expiresAt,
        },
      },
    },
  };
  const receipt = {
    status: "accepted",
    requestId: request.requestId,
    commitId: generated.commitId,
    revision,
    actionKind: SUBMIT_OBJECTIVE,
    runId: run.id,
    acceptedAt: generated.acceptedAt,
  };
  return {
    candidate: {
      commitId: generated.commitId,
      predecessor: state.cursor.commitId,
      revision,
      requestId: request.requestId,
      requestDigest: operatorRequestDigest(request),
      requestContent: operatorRequestContent(request),
      receipt,
      run,
      consumedOffer: request.offer,
      createdOffers,
      offerConstraintsDigest: canonicalDigest(offer.constraints),
      audit: {
        actionKind: SUBMIT_OBJECTIVE,
        principal: request.principal,
        runId: run.id,
        recordedAt: generated.acceptedAt,
      },
      effectIntents: [
        {
          id: generated.effectIntentId,
          kind: "StartPlanningExecution",
          disposition: "Pending",
        },
      ],
      artifacts: [],
    },
  };
}

export function projectOperatorReply(state, principal, locale, result) {
  const copy = CORE_OPERATOR_COPY[locale];
  const projectedOffers =
    state.recovery === null
      ? state.offers
          .filter(
            (offer) =>
              offer.principal === principal &&
              offer.revision === state.cursor.revision &&
              offer.consumedRevision === null,
          )
          .sort((left, right) =>
            left.actionKind.localeCompare(right.actionKind),
          )
          .map((offer) => ({
            kind: offer.actionKind,
            offer: offer.offer,
            constraints: structuredClone(offer.constraints),
          }))
      : [];
  let runCopy;
  let runAuthority = {};
  if (state.run !== null) {
    if (state.run.condition === "Terminal") {
      runCopy = {
        status:
          state.run.outcome === "Abandoned"
            ? copy.abandonedStatus
            : copy.cancelledStatus,
        nextAction: copy.terminalNextAction,
      };
    } else if (state.run.condition === "Cancelling") {
      runCopy = {
        status: copy.cancellingStatus,
        nextAction: copy.cancellingNextAction,
      };
    } else if (state.run.stage === "Coding") {
      runCopy = {
        status: copy.codingStatus,
        nextAction: copy.codingNextAction,
      };
    } else if (state.run.condition === "Waiting for Operator") {
      runCopy = {
        status: copy.planningWaitingStatus,
        nextAction: copy.planningWaitingNextAction,
      };
    } else {
      runCopy = {
        status: copy.planningStatus,
        nextAction: copy.planningNextAction,
      };
    }
    const actors =
      state.run.condition === "Terminal"
        ? { currentActor: "Operator", nextActor: null }
        : state.run.condition === "Cancelling"
          ? { currentActor: "Runtime Core", nextActor: "Operator" }
          : state.run.stage === "Coding"
            ? { currentActor: "Coding Agent", nextActor: "Operator" }
            : state.run.condition === "Waiting for Operator"
              ? { currentActor: "Operator", nextActor: null }
              : {
                  currentActor: "Orchestrator Agent",
                  nextActor: "Operator",
                };
    runAuthority = {
      stage: state.run.stage,
      condition: state.run.condition,
      ...actors,
      lastCommittedTransition: state.run.lastCommittedTransition,
      planRevision: state.run.planRevision,
      legalActions: projectedOffers.map(({ kind }) => kind),
    };
  }
  return {
    ...result,
    cursor: structuredClone(state.cursor),
    view: {
      locale,
      authorityEpoch: state.authorityEpoch,
      run: structuredClone(state.run),
      latestReceipt: structuredClone(state.latestReceipt),
      ...runAuthority,
      ...(state.recovery === null
        ? {}
        : { recovery: structuredClone(state.recovery) }),
      copy:
        state.recovery !== null
          ? {
              status: copy.reconciliationStatus,
              nextAction: copy.reconciliationNextAction,
            }
          : state.run === null
          ? {
              status: copy.idleStatus,
              nextAction: copy.idleNextAction,
            }
          : runCopy,
    },
    offers: projectedOffers,
  };
}
