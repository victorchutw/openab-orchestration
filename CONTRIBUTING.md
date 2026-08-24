# Contributing

OpenAB Orchestration accepts reviewed pull requests for public product source,
tests, schemas, documentation, and wholly synthetic fixtures. Contributions do
not confer merge, roadmap, release, support, or governance authority.

Read [`LICENSE_SCOPE.md`](./LICENSE_SCOPE.md) before editing. The migrated
reports it lists do not accept substantive contributions while their rights are
uncleared. Never submit credentials, private Installation Configuration,
runtime records, logs, sessions, target workspaces, deployment inventory, or
real Evidence Bundles.

## Developer Certificate of Origin

This project uses [Developer Certificate of Origin 1.1](./DCO.md) sign-off and
has no Contributor License Agreement or copyright assignment. Every commit must
carry a sign-off from the responsible natural person:

```text
Signed-off-by: Your Name <your-email@example.com>
```

Create it with `git commit --signoff`. By signing, you certify the DCO for that
commit and confirm that you have the employer, upstream, and other authority
needed to submit it.

## Agent- and AI-assisted work

Agent- or AI-assisted contributions are allowed only when a responsible natural
person reviews the final content and can truthfully make the DCO certification.
The pull request must disclose material agent or AI generation, name the areas
affected, and summarize the human verification performed. An unattended bot
cannot make this certification or replace human accountability.

Authorized implementation work follows the [bounded implementation
loop](./docs/agents/implementation-loop.md): one eligible ticket, observable
acceptance evidence, an independent review of the exact candidate, at most one
review-fix pass, and a human handoff. Recurring discovery remains read-only
until a maintainer authorizes the next bounded unit of work.

## Branches and pull requests

Use one short-lived `issue-<number>-<slug>` branch per accepted ticket. Keep
`main` releasable; this repository does not use a long-lived development branch
or GitFlow. Commits remain reviewable units and carry both DCO sign-off and a
`Refs: #<number>` trailer.

Push and open a pull request only after the maintainer authorizes publication.
Link the ticket with `Closes #<number>`, disclose material AI assistance, and
keep the pull-request head stable during independent review. Any new commit
supersedes review evidence for the previous head and must pass CI and focused
re-review before handoff.

`main` accepts pull requests through rebase merge after the required `Verify`
check passes. A second-human approval is not mechanically required while the
project has one maintainer; independent review evidence and the maintainer's
final content review are still required. Merge is a separate maintainer
decision. The complete operational sequence is the [pull-request development
workflow](./docs/agents/pull-request-workflow.md).

## Verification

Run the same clean-checkout entry points used by maintainers:

```bash
npm run check
npm run build
npm test
npm run check:public -- --revision HEAD
```

The product uses Node.js 22.13 or newer and has no runtime package dependencies.
The last command performs the automated public-boundary scan used by CI; it
does not replace the human exposure review below.

## Public exposure review

Before every public push that adds migrated or operational material:

1. Stage the exact intended change and run `npm run check:public`.
2. Inspect the complete staged tree, including generated and binary files.
3. Inspect every ref and the complete reachable history, not only the latest
   diff or current branch.
4. Perform and record a human exposure review for real identities, endpoints,
   paths, bindings, operational facts, third-party rights, and sensitive
   context that an automated scanner cannot classify.

The automated check covers suspicious public paths and common credential
shapes in both the staged tree and reachable history. A passing result does not
approve publication. Ignore rules and automated checks are defense in depth;
human exposure review is still required before the push.

Security vulnerabilities and private material do not belong in an issue or
pull request. Follow [`SECURITY.md`](./SECURITY.md) instead. Community
participation is governed by [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
