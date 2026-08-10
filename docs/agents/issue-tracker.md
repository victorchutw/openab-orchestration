# Issue tracker: GitHub

Planning issues live in the public `victorchutw/openab-orchestration`
repository. Use the `gh` CLI and pass `--repo victorchutw/openab-orchestration`
explicitly in automation.

Issue titles and bodies are English. Human-facing narration refers to each
issue by linked title, never by a bare number.

## Basic operations

- Create: `gh issue create --repo victorchutw/openab-orchestration --title "..." --body "..."`
- Read: `gh issue view <number> --repo victorchutw/openab-orchestration --comments`
- List: `gh issue list --repo victorchutw/openab-orchestration --state open --json number,title,labels,assignees`
- Comment: `gh issue comment <number> --repo victorchutw/openab-orchestration --body "..."`
- Label: `gh issue edit <number> --repo victorchutw/openab-orchestration --add-label "..."`
- Claim: `gh issue edit <number> --repo victorchutw/openab-orchestration --add-assignee @me`
- Close: `gh issue close <number> --repo victorchutw/openab-orchestration --comment "..."`

## Wayfinding operations

The Wayfinder map is one issue labelled `wayfinder:map`. Decision tickets are
GitHub sub-issues of that map and carry exactly one type label:
`wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or
`wayfinder:task`.

Create all issues before wiring relationships. Obtain a ticket's numeric
database ID with:

```bash
gh api repos/victorchutw/openab-orchestration/issues/<ticket> --jq .id
```

Attach it to the map:

```bash
gh api --method POST \
  repos/victorchutw/openab-orchestration/issues/<map>/sub_issues \
  -F sub_issue_id=<ticket-database-id>
```

Add a native blocking edge using the blocker's numeric database ID:

```bash
gh api --method POST \
  repos/victorchutw/openab-orchestration/issues/<blocked>/dependencies/blocked_by \
  -F issue_id=<blocker-database-id>
```

The frontier is the map's open, unassigned child issues with no open blockers.
Claim a frontier ticket before reading beyond the map-level summary or doing
ticket work. Resolve one non-research ticket per session: post the answer as a
resolution comment, close the ticket, then append one linked gist to the map's
`Decisions so far` section.

The map body is an index. Open tickets stay discoverable as child issues; their
questions and answers are not duplicated into the map.
