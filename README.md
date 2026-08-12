# OpenAB Orchestration

Greenfield, local-first development orchestration for OpenAB agents. This is an
independent, unofficial OpenAB integration and is not endorsed by the upstream
OpenAB project.

The planning destination is complete and greenfield implementation has begun.
The current `0.1.0` bootstrap provides a buildable product entry point and a
fail-closed Installation preflight before any Runtime Core or worker starts.
The complete MVP remains one coding and review loop:

```text
Operator
   |
   v
Orchestrator Agent (PM)
   |
   v
Coding Agent
   |
   v
Immutable Review Target
   |              |
   v              v
Reviewer A     Reviewer B
   |              |
   +------+-------+
          v
Review Synthesis
          |
   optional bounded remediation
          |
          v
Operator Decision
```

The deterministic Runtime Core will run as a normal process on one Linux host.
OpenAB agent runtimes will remain isolated in k3s. Git is product and target
source control, not the operational source of truth.

## Status

- Bootstrap implementation only; the Runtime Core and adapters are not yet
  implemented and no production deployment is supported.
- One Orchestrator Agent, one Coding Agent, and two decision-isolated Reviewer
  Agents are in the MVP destination.
- One bounded remediation round is allowed before returning to the Operator.
- The Operator retains final commit, push, pull request, merge, deployment,
  cancellation, and policy-exception authority.
- Runtime data, credentials, agent sessions, and evidence stay outside this
  public checkout.

## Build and preflight

Node.js 22 or newer is required. The product has no runtime package
dependencies.

```bash
npm run check
npm run build
npm test
dist/openab-orchestration-v0.1.0.mjs modes
dist/openab-orchestration-v0.1.0.mjs preflight \
  --config config/examples/synthetic-installation.json \
  --product-root "$PWD"
```

The synthetic preflight is local-only: it validates public placeholder shapes
without resolving credentials or contacting a provider, GitHub, Discord, k3s,
or any other infrastructure. See the [preflight operator
guide](./docs/operators/preflight.md) before creating private Installation
Configuration.

## Repository map

- [Domain language](./CONTEXT.md)
- [Research library](./docs/research/README.md)
- [Legacy provenance](./docs/legacy/provenance.md)
- [Issue tracker operations](./docs/agents/issue-tracker.md)
- [Configuration Contract](./config/configuration-contract.schema.json)
- [Synthetic Installation](./config/examples/synthetic-installation.json)
- [License scope](./LICENSE_SCOPE.md)
- [Contribution guide](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)

The completed design map is [Design the greenfield OpenAB coding and review
MVP](https://github.com/victorchutw/openab-orchestration/issues/1).
Research and planning documents do not silently become accepted architecture.

## Public boundary

This repository contains public source, specifications, examples, migrations,
and non-sensitive research. Private deployment bindings, credentials, runtime
databases, session state, worktrees, and evidence bundles belong outside the
checkout.

Victor Chu-owned greenfield material is available under the MIT License, with
explicit migrated and third-party exclusions described in
[`LICENSE_SCOPE.md`](./LICENSE_SCOPE.md). Public visibility alone does not grant
rights to excluded material.
