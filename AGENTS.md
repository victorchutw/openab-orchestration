# Repository instructions

Discuss decisions with the maintainer in Traditional Chinese (`zh-TW`). Keep
new repository artifacts, code, identifiers, and issue content in English.
Migrated research may retain its original language.

## Wayfinding

This repository is planning-first. Before managing the Wayfinder map or its
tickets, read `docs/agents/issue-tracker.md`. Refer to issues by linked title in
human-facing text. Implement only after the map reaches its destination and the
maintainer authorizes an implementation handoff.

Before implementing an authorized ticket, read
`docs/agents/implementation-loop.md`. Work on one eligible leaf ticket through
its bounded implementation, independent review, and human handoff.

## Domain language

Read `CONTEXT.md` when changing product concepts. Update it only when a term is
resolved with the maintainer; keep implementation choices out of the glossary.

## Legacy material

Treat `docs/research/` as non-normative input and `docs/legacy/provenance.md` as
the migration record. Re-evaluate legacy decisions against the greenfield
destination instead of importing their status, structure, or vocabulary.

## Public boundary

Keep credentials, deployment bindings, runtime databases, agent sessions,
worktrees, and evidence bundles outside the checkout. Verify the complete
staged tree and reachable history for public exposure before every push that
adds migrated or operational material.
