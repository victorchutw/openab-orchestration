import { createHash as coreCreateHash } from "node:crypto";

export const SUBMIT_OBJECTIVE = "SubmitObjective";
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
  }),
  "zh-TW": Object.freeze({
    idleStatus: "沒有進行中的 Run",
    idleNextAction: "提交目標",
    planningStatus: "Run 正在 Planning 階段進行",
    planningNextAction: "等待 Orchestrator Agent 提出 Run Plan",
  }),
});

function coreRequireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

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

function coreCanonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(coreCanonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, coreCanonicalize(value[key])]),
    );
  }
  return value;
}

function coreDigest(value) {
  return `sha256:${coreCreateHash("sha256")
    .update(JSON.stringify(coreCanonicalize(value)))
    .digest("hex")}`;
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
  coreRequireNonEmptyString(request.requestId, "requestId");
  coreRequireNonEmptyString(request.offer, "offer");
  coreRequireOnlyKeys(request.action, ["kind", "payload"], "action");
  if (request.action.kind !== SUBMIT_OBJECTIVE) {
    throw new TypeError(`action.kind must be ${SUBMIT_OBJECTIVE}`);
  }
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
}

export function authorizeOperatorRequest(request, operatorIdentity) {
  coreRequireNonEmptyString(request?.principal, "principal");
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

export function createInitialOffer(offer, principal) {
  coreRequireNonEmptyString(offer, "identifiers.offer result");
  return {
    offer,
    principal,
    revision: 0,
    actionKind: SUBMIT_OBJECTIVE,
    constraints: SUBMIT_OBJECTIVE_CONSTRAINTS,
    consumedRevision: null,
  };
}

export function operatorRequestDigest(request) {
  return coreDigest({
    principal: request.principal,
    offer: request.offer,
    action: request.action,
  });
}

export function proposeOperatorAction(state, request, generated) {
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
    offer.actionKind !== request.action.kind ||
    coreDigest(offer.constraints) !== coreDigest(SUBMIT_OBJECTIVE_CONSTRAINTS)
  ) {
    return {
      rejection: {
        code: "MismatchedOffer",
        message: "offer is not bound to this principal, action, and constraints",
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

  for (const [field, value] of Object.entries(generated)) {
    coreRequireNonEmptyString(value, field);
  }
  const revision = state.cursor.revision + 1;
  const run = {
    id: generated.runId,
    objective: request.action.payload.objective,
    stage: "Planning",
    condition: "Active",
    reviewRound: null,
    outcome: null,
    createdAt: generated.acceptedAt,
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
      receipt,
      run,
      consumedOffer: request.offer,
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
    },
  };
}

export function projectOperatorReply(state, principal, locale, result) {
  const copy = CORE_OPERATOR_COPY[locale];
  return {
    ...result,
    cursor: structuredClone(state.cursor),
    view: {
      locale,
      run: structuredClone(state.run),
      copy:
        state.run === null
          ? {
              status: copy.idleStatus,
              nextAction: copy.idleNextAction,
            }
          : {
              status: copy.planningStatus,
              nextAction: copy.planningNextAction,
            },
    },
    offers: state.offers
      .filter(
        (offer) =>
          state.run === null &&
          offer.principal === principal &&
          offer.revision === state.cursor.revision &&
          offer.consumedRevision === null,
      )
      .sort((left, right) => left.actionKind.localeCompare(right.actionKind))
      .map((offer) => ({
        kind: offer.actionKind,
        offer: offer.offer,
        constraints: structuredClone(offer.constraints),
      })),
  };
}
