# Legacy research provenance

## Purpose

This repository started from a clean Git history. It does not inherit the
architecture, accepted ADR status, operational state, or deployment identity
of the private legacy `openab-vault` repository.

Selected research was copied on 2026-08-10 because it contains reusable facts,
alternatives, and failure analysis. References to "this repository", accepted
ADRs, a Control Repository, GitHub-owned work state, existing registries, or
current deployments describe the legacy system and are non-normative here.

The five files in this record are also explicitly outside the project's MIT
grant while their rights remain uncleared. See
[`LICENSE_SCOPE.md`](../../LICENSE_SCOPE.md) for the controlling license scope;
public readability does not grant reuse permission.

## Source snapshot

Tracked reports came from legacy commit
`3880d32e129017d6d5adc61de5405dc9fc9ae189`. The runtime SSOT reports were
completed in that legacy working tree after the commit and are identified by
content digest instead.

| Migrated path | Source SHA-256 |
| --- | --- |
| `docs/research/openab-upstream-orchestration.md` | `535b0618fff608cf12877df2ae09c0d7611fc5f264c8da618f971fd0c17f3d3a` |
| `docs/research/openab-independent-review-sessions.md` | `f7e0c9040c72c73d2f2fc7fd25fbfc9ec5bb66472ddbdec3963d9fc9e83362cb` |
| `docs/research/graph-engineering.md` | `22f11fd1c37ba3197d51a56640cad136829c91ef8018ae35a34f7736af236214` |
| `docs/research/runtime-ssot-alternatives.md` | `0f9019214a3ef8e2e6110876e347269f58300d0522fa48feeae3961003a98413` |
| `docs/research/runtime-ssot-alternatives.html` | `71f07da0b89aff7bf5cb876c8b5f485633a086b1543b81c0e6126df8a33db9ce` |

The digests describe the source content before migration notices and legacy
link adjustments were added.

## Migration adjustments

- Added a visible non-normative migration notice to every report.
- Redirected relative links to private legacy ADRs, registries, scripts, and
  glossaries to this provenance record.
- Preserved original research language and external primary-source links.
- Excluded legacy code, schemas, ADRs, GitHub workflows, registries,
  deployment configuration, runtime state, and Git history.

## Operational separation

The two legacy reviewer deployments were scaled to zero before this repository
was bootstrapped. Their private namespaces, credentials, configuration, and
persistent volumes were retained for a later explicit retirement decision and
were not copied here. Other projects in the same k3s cluster were left running.
