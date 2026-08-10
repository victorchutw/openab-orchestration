# OpenAB Orchestration

Greenfield, local-first development orchestration for OpenAB agents.

This public repository is currently in a Wayfinder planning phase. Its first
destination is a decision-complete MVP specification for one complete coding
and review loop:

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

- Planning only; implementation has not started.
- One Orchestrator Agent, one Coding Agent, and two decision-isolated Reviewer
  Agents are in the MVP destination.
- One bounded remediation round is allowed before returning to the Operator.
- The Operator retains final commit, push, pull request, merge, deployment,
  cancellation, and policy-exception authority.
- Runtime data, credentials, agent sessions, and evidence stay outside this
  public checkout.

## Repository map

- [Domain language](./CONTEXT.md)
- [Research library](./docs/research/README.md)
- [Legacy provenance](./docs/legacy/provenance.md)
- [Issue tracker operations](./docs/agents/issue-tracker.md)

The canonical Wayfinder map is a GitHub Issue labelled `wayfinder:map`. Open
decision tickets are its child issues; research and planning documents do not
silently become accepted architecture.

## Public boundary

This repository contains public source, specifications, examples, migrations,
and non-sensitive research. Private deployment bindings, credentials, runtime
databases, session state, worktrees, and evidence bundles belong outside the
checkout.

No license has been selected yet. Public visibility does not grant reuse
rights; licensing is an explicit Wayfinder decision.
