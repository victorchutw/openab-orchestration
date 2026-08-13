# Installation preflight

Preflight validates one Configuration Contract before a Runtime Core or worker
starts. It is deliberately local-only: it reads one JSON document and local
filesystem metadata, produces a non-secret Runtime Core projection, and makes no
network or provider calls.

The supported bootstrap requires Node.js 22.13 or newer on Linux. Build one
versioned artifact from a clean checkout:

```bash
npm run check
artifact_path="$(npm run build --silent)"
npm test
```

The build prints the path to the resulting
`dist/openab-orchestration-v<version>.mjs` executable in `artifact_path`. It
exposes these planned process modes from the same product artifact:

- `runtime-core` — Runtime Core
- `execution-worker` — Execution Worker
- `github-publisher` — GitHub Publisher
- `discord-operator-interface` — Discord Operator Interface

This bootstrap identifies the modes but does not start their future process
implementations.

## Validate the public example

[`config/examples/synthetic-installation.json`](../../config/examples/synthetic-installation.json)
contains descriptions of private shapes, not usable bindings. Validate it with:

```bash
artifact_path="$(npm run build --silent)"
"$artifact_path" preflight \
  --config config/examples/synthetic-installation.json \
  --product-root "$PWD"
```

A successful reply states `synthetic: true` and
`contactedExternalInfrastructure: false`. The example contains no real
endpoint, identity, filesystem path, deployment binding, secret-reference
value, or Secret Material, so it cannot reach real infrastructure.

## Prepare a private Installation

The public [Configuration
Contract](../../config/configuration-contract.schema.json) defines constraints,
safe defaults, and the difference between `SyntheticInstallation` placeholder
objects and private `Installation` bindings. Create the real document outside
the Product Repository checkout and outside Git. Do not derive it by replacing
placeholders in a tracked file.

Before preflight, create three existing, private directories:

- an Operator-controlled primary storage root;
- a separately chosen recovery storage root;
- an Execution Workspace root.

Primary and recovery roots must resolve to different locations. Different path
strings or a symlink do not make the same location distinct. Qualification of
separate storage failure domains is a later installation gate; this bootstrap
does not claim it from path inspection alone.

Complete every authority-sensitive binding: the Operator identity; all four
Agent Role Identities; the GitHub Target Repository; the Discord Operator; and
the required worker secret references. The fail-closed reviewer-diversity
default is `distinct-serving-providers`.

Run preflight with the private path:

```bash
artifact_path="$(npm run build --silent)"
"$artifact_path" preflight \
  --config /private/configuration/location/installation.json \
  --product-root "$PWD"
```

Preflight rejects:

- private Installation Configuration, storage, or workspaces inside the
  checkout;
- missing or unresolved filesystem locations;
- primary and recovery roots that resolve to one location;
- inline fields shaped like credential or Secret Material payloads;
- missing process, identity, target, diversity, or worker-reference authority.

## Secret and Runtime Core boundary

Installation Configuration contains private secret locators and non-secret
generations, never payloads. Each future worker receives only its own resolution
plan. Runtime Core has no secret-resolution plan and receives only the effective
configuration revision, a SHA-256 digest of the non-secret effective
configuration, and secret-reference generations. Preflight output never emits
paths, identities, endpoints, target bindings, or secret-reference values.

Environment providers use uppercase variable names. File providers use existing
absolute files that resolve outside the Product Repository; preflight inspects
only path metadata and never reads the Secret Material. Every reference uses an
explicit non-secret `generation:<id>` identifier. Store actual payloads outside
configuration, Git, runtime records, and evidence.

## Public push gate

Before a public push involving migrated or operational material, stage the exact
tree and run:

```bash
npm run check:public
```

The check scans suspicious paths and credential shapes in both staged content
and every reachable Git blob. It cannot decide whether real identities,
endpoints, paths, operational facts, or third-party rights are appropriate for
publication. A complete human exposure review of the staged tree and reachable
history remains mandatory even when the automated check passes.
