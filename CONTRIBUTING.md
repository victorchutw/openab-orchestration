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

## Verification

Run the same clean-checkout entry points used by maintainers:

```bash
npm run check
npm run build
npm test
```

The product uses Node.js 22.13 or newer and has no runtime package dependencies.

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
