# Runtime Core Operator objective

The first Runtime Core transition accepts one objective from the authenticated
Operator and creates one non-terminal Run. Callers use the same transport-neutral
interface from source or from the versioned product artifact:

```js
const core = openRuntimeCore({
  primaryRoot,
  recoveryRoot,
  operatorIdentity,
  configurationRevision,
  effectiveConfigurationDigest,
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

## Observe

`Observe` returns a monotonic `{ revision, commitId }` cursor, the current Run
projection, and the Operator Actions legal at that cursor. With no
non-terminal Run, exactly one opaque `SubmitObjective` offer is returned. The
offer is bound to the authenticated Operator, current revision, action kind,
and objective constraints. Callers treat its value as opaque.

The supported locales are `en` and `zh-TW`. Locale changes presentation copy
only. Run values, action kinds, offer values, constraints, cursors, and
receipts retain their canonical English identifiers and identical semantics.

## Act and durable receipts

`SubmitObjective` accepts an objective from 1 through 4096 characters. A valid
Act creates one Run with Stage `Planning` and Condition `Active`, consumes the
offer, creates the pending Planning Effect Intent, and returns an accepted
receipt.

The Runtime Core writes and verifies an immutable recovery commit capsule
before applying that exact Commit ID in one authoritative SQLite transaction.
The transaction updates the current projection and appends immutable audit,
request-receipt, commit-identity, and Effect Intent records. Acceptance is
returned only after the capsule and SQLite identity verify. Authority is read
from the current projection; it is not reconstructed solely by replaying the
audit history.

Restart verifies the authoritative head against recovery storage. If the one
next capsule is durable but its matching SQLite transaction was interrupted,
restart verifies and completes that same Commit ID before exposing the Run. A
missing or changed capsule is an integrity error and startup fails closed.

## Replay and rejection

Replay an indeterminate Act with the same request ID, offer, principal, action,
and payload. Exact replay returns the original receipt with disposition
`duplicate`; locale may change because it selects only the accompanying view.
It does not create another revision, Run, or Effect Intent.

Reusing a request ID with different content returns `RequestIdConflict`.
Consumed capabilities return `StaleOffer`; unknown or incorrectly bound
capabilities return `MismatchedOffer`. Rejections expose the unchanged cursor.
No second objective is offered while the first Run remains non-terminal.

Call `core.close()` during orderly process shutdown. An Operator Interface may
cache a projection for presentation, but the cache, transport history, and
agent sessions never replace Runtime Core authority.
