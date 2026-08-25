# Runtime Core planning contract

The first Runtime Core transition accepts one objective from the authenticated
Operator and creates one non-terminal Run. Callers use the same transport-neutral
interface from source or from the versioned product artifact:

```js
const core = openRuntimeCore({
  primaryRoot,
  recoveryRoot,
  operatorIdentity,
  orchestratorIdentity,
  planningExecutionProfile,
  executionProfiles: [
    {
      id: "profile:coding-primary",
      role: "coding",
      agentRoleIdentity: "agent-role:coding",
      servingProvider: "provider:coding-primary",
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
  configurationRevision,
  effectiveConfigurationDigest,
  secretReferenceGenerations,
});

const observation = await core.operator({
  kind: "Observe",
  principal: operatorIdentity,
  locale: "en",
});

const reply = await core.operator({
  kind: "Act",
  principal: operatorIdentity,
  locale: "en",
  requestId,
  offer: observation.offers[0].offer,
  action: {
    kind: "SubmitObjective",
    payload: { objective },
  },
});
```

`primaryRoot` and `recoveryRoot` are private Installation bindings validated by
preflight. They must remain outside the Product Repository and resolve to
distinct storage locations. Runtime databases, commit capsules, Operator
objectives, receipts, and audit records are private runtime records and must
not be copied into the checkout or an issue.

`secretReferenceGenerations` is the non-secret purpose-to-generation map from
preflight. The Runtime Core records this map with the effective configuration
digest. It never receives or resolves Secret Material.

## Observe

`Observe` returns a monotonic `{ revision, commitId }` cursor, the current Run
projection, the latest accepted receipt, and the Operator Actions legal at that
cursor. With no non-terminal Run, exactly one opaque `SubmitObjective` offer is
returned. The offer is bound to the authenticated Operator, current revision,
authority epoch, action kind, and objective constraints. Callers treat its
value as opaque. Every normal view also discloses the current `authorityEpoch`.

The supported locales are `en` and `zh-TW`. Locale changes presentation copy
only. Run values, action kinds, offer values, constraints, cursors, and
receipts retain their canonical English identifiers and identical semantics.

## Act and durable receipts

`SubmitObjective` accepts an objective from 1 through 4096 characters. A valid
Act creates one Run with Stage `Planning` and Condition `Active`, consumes the
offer, creates the pending Planning Effect Intent and immutable Planning
Execution, and returns an accepted receipt. While that Execution is pending,
the Operator may request `AbandonRun` or `CancelRun`; either request enters
`Cancelling` until active or uncertain work is proven stopped or isolated.

The Runtime Core writes and verifies an immutable recovery commit capsule
before applying that exact Commit ID in one authoritative SQLite transaction.
The transaction updates the current projection and appends immutable audit,
request-receipt, commit-identity, and Effect Intent records. Acceptance is
returned only after the capsule and SQLite identity verify. Authority is read
from the current projection; it is not reconstructed solely by replaying the
audit history.

SQLite writer serialization begins before checking or publishing a prepared
capsule. At most one next revision may remain prepared for an Installation. A
different request cannot publish another capsule until the prepared request is
completed or the Runtime Core enters explicit recovery.

Restart verifies the authoritative head against recovery storage. If the one
next capsule is durable but its matching SQLite transaction was interrupted,
restart verifies and completes that same Commit ID before exposing the Run. A
missing or changed capsule is an integrity error and startup fails closed.

Each acknowledged state retains immutable, digest-verified SQLite generations.
The recovery boundary also retains the contiguous ordered capsule tail and the
same content-addressed artifact bytes referenced by SQLite and the capsules.
The current implementation retains every verified generation; it does not
prune an older known-good generation. Consequently at least two independently
restorable generations exist after the first accepted transition.

## Explicit primary-storage Restore

If the authoritative database is missing while recovery material exists,
opening the Runtime Core does not create a replacement database, apply a tail,
or select a rollback point. `Observe` instead returns `RecoveryRequired`,
`Waiting for Operator`, and all verified recovery points for the highest known
authority epoch. Every offered point names its source and target cursors,
configuration and secret-reference generations, capsule-tail length, and
referenced-artifact count. Points from older generations are offered only when
they reconstruct the same latest authoritative head; Restore never offers an
older head as a rollback. The Runtime Core selects the highest known authority
epoch before matching the current configuration. Conflicting heads at that
epoch fail closed instead of selecting one by ordering or arrival time.

When the current preflight inputs do not match the frozen configuration or
secret-reference generations, `Observe` discloses the required non-secret
generations but offers no Restore action. The Operator must restore those
inputs and reopen the Runtime Core. The frozen Run is not weakened or changed.

Select one offered point using its opaque recovery point ID and the separate
Restore offer:

```js
const recovery = await core.operator({
  kind: "Observe",
  principal: operatorIdentity,
  locale: "en",
});

const point = recovery.view.recovery.recoveryPoints[0];
const restored = await core.operator({
  kind: "Act",
  principal: operatorIdentity,
  locale: "en",
  requestId: crypto.randomUUID(),
  offer: recovery.offers[0].offer,
  action: {
    kind: "Restore",
    payload: { recoveryPoint: point.id },
  },
});
```

Restore copies the selected verified generation into a candidate, applies and
verifies its contiguous capsule tail and durable rejection receipts,
reconstructs every referenced artifact from recovery CAS, and runs SQLite and
domain integrity checks. The fully verified candidate, including its incremented
authority epoch and durable Restore receipt, must reach the recovery boundary as
a new generation before the database is atomically activated. Activation fences
every capability from the earlier epoch. When no Effect Intent requires
Reconciliation, each action that was legal at the restored cursor receives a
fresh opaque offer bound to the new authority epoch; the Restore activation
record durably binds and verifies that complete replacement set. A failed
activation leaves no authoritative database and can be retried only after the
failure is observed and corrected.

The pre-activation generation does not make its accepted receipt externally
final. A separate immutable completion record is written only after the atomic
activation verifies. If activation is interrupted first, an exact replay of the
same Restore request activates that prepared generation under the same authority
epoch and then returns its receipt. Once completion is recorded, later exact
replays are duplicates and a later primary loss requires a newly selected Restore.

An `Act` that does not match the current Restore offer or one of its disclosed
points receives a durable rejected receipt and the latest `RecoveryRequired`
view. Exact retries return that receipt without adding another disposition.
The receipt remains in the recovery boundary and is incorporated when a later
authorized Restore activates the database.

Known pending, active, or uncertain Effect Intents are not dispatched,
cancelled, or declared failed by Restore. They appear under an
Installation-wide `Reconciliation` recovery gate and the Operator view's next
action is to reconcile those effects. Reopening the Runtime Core preserves the
gate, cursor, Run, original receipts, audit history, and one authoritative
head. Earlier-epoch effect participation is recorded as late-evidence-only
when a later restore supersedes its gate.

## Planning Execution Pull and Report

The scripted planning adapter uses the same transport-neutral Execution seam
that a later qualified worker will use:

```js
const offered = await core.execution({
  kind: "Pull",
  agentRoleIdentity: orchestratorIdentity,
});

const report = await core.execution({
  kind: "Report",
  agentRoleIdentity: orchestratorIdentity,
  factId,
  directive: offered.directive.capability,
  result,
  evidence,
});
```

`Pull` returns an `openab.execution-directive/v1` value bound to one Execution
ID, Run and plan revision, Orchestrator Agent Role Identity, immutable Execution
Profile, `openab.execution-context/v1` value, authority epoch, delivery
generation, and `StartPlanningExecution` Effect Intent. The context contains
the objective, the Installation's eligible Coding and Reviewer Execution
Profiles, the distinct-Serving-Provider reviewer policy, and, for a revision,
the prior plan and Operator guidance. The directive carries a 600,000
millisecond safety limit. At or after its deadline, Pull reports expiry and a
Report cannot establish Execution Completion.

A successful result has this shape:

```js
{
  format: "openab.planning-execution-result/v1",
  executionId,
  planRevision,
  agentRoleIdentity: orchestratorIdentity,
  executionProfileId: planningExecutionProfile.id,
  outcome: "Succeeded",
  runPlan: {
    objective,
    scope: ["..."],
    acceptanceBoundary: ["..."],
    evidenceRequirements: ["..."],
    remediationAllowance: { maximumRounds: 1 },
    eligibleExecutionProfiles: {
      coding: ["profile:..."],
      reviewerA: ["profile:..."],
      reviewerB: ["profile:..."]
    },
    fallbackOrder: {
      coding: ["profile:..."],
      reviewerA: ["profile:..."],
      reviewerB: ["profile:..."]
    },
    reviewerDiversityMode: "distinct-serving-providers"
  }
}
```

Every proposed profile must be configured for its declared role in the
directive's immutable planning policy, and every eligible profile must appear
exactly once in that role's deterministic fallback order. Reviewer A and
Reviewer B profiles must retain distinct Agent Role Identities and Serving
Providers. Evidence uses `openab.verification-evidence/v1`, kind
`ScriptedPlanningResult`, and a `resultDigest` equal to the canonical digest of
the complete result. A Report is only an observation: wrong directive,
identity, profile, revision, result format, evidence, policy, or timing is
rejected without Completion or a cursor change. A valid Report reaches the
recovery-first commit boundary, records the Planning Effect Intent transition
from `Pending` to `Completed`, and then moves the Run to
`Planning / Waiting for Operator`.

## Operator Run Plan actions

After a valid Planning result, Observe offers `ConfirmPlan`, `RevisePlan`,
`AbandonRun`, and `CancelRun` as opaque cursor-bound capabilities.

- `RevisePlan` accepts bounded textual guidance. It creates the next plan
  revision and a fresh initial Orchestrator Execution, directive, context, and
  Effect Intent in the same Run. It does not consume a failure replacement.
- `ConfirmPlan` freezes the objective, scope, acceptance boundary, evidence
  requirements, one-round remediation allowance, eligible profiles, fallback
  order, and distinct-Serving-Provider reviewer policy. The Run then enters
  `Coding / Active`, where a fresh `RequestPlanChange` capability is the only
  planning-boundary action. An unchanged objective, scope, and acceptance
  boundary is rejected as `NoMaterialChange`; changing any of them is rejected
  as `SuccessorRunRequired`. This planning implementation does not dispatch
  Coding.
- `AbandonRun` with no active work commits terminal `Abandoned`. With active
  Planning work it enters `Cancelling` and records that Abandonment follows
  convergence. `CancelRun` follows the same convergence rule and can commit
  terminal `Cancelled` when no work remains active or uncertain.
- A pre-confirmation `RevisePlan` offer becomes stale at confirmation and
  cannot mutate the confirmed Run. Post-confirmation boundary changes require
  the newly bound `RequestPlanChange` capability and a Successor Run.

Each Run view exposes canonical Stage, Condition, current and next actor, last
committed transition, plan revision, and legal action kinds. `en` and `zh-TW`
select presentation copy only; capabilities, constraints, results, receipts,
cursors, and transitions are identical.

## Replay and rejection

Replay an indeterminate Act with the same request ID, offer, principal, action,
and payload. Exact replay returns the original receipt with disposition
`duplicate`; locale may change because it selects only the accompanying view.
It does not create another revision, Run, or Effect Intent.

Reusing a request ID with different content returns `RequestIdConflict`.
Consumed capabilities return `StaleOffer`; unknown or incorrectly bound
capabilities return `MismatchedOffer`. Rejections expose the unchanged cursor
and a durable receipt. The Runtime Core persists and verifies an immutable
recovery receipt capsule before recording that receipt in SQLite. Exact replay
of rejected content returns the original rejection receipt across restart; a
request-ID conflict is retained separately without replacing the first final
disposition. No second objective is offered while the first Run remains
non-terminal.

Call `core.close()` during orderly process shutdown. An Operator Interface may
cache a projection for presentation, but the cache, transport history, and
agent sessions never replace Runtime Core authority.
