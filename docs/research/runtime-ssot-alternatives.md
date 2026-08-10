# Research: Alternatives to Git/GitHub as the Operational Source of Truth

> [!IMPORTANT]
> This report was migrated as non-normative research. References to current
> repository decisions, ADRs, registries, and boundary scripts describe the
> legacy system and do not constrain this greenfield repository. See
> [legacy provenance](../legacy/provenance.md).

- Date: 2026-08-07
- Scope: replacing the latency-sensitive operational authority for a
  single-maintainer OpenAB MVP while keeping source control intact
- Status: architecture research and a recommendation; not implementation,
  migration, or live-canary approval

## Executive conclusion

Yes, but the useful change is **moving operational authority off the GitHub
round-trip**, not merely adding a database. Git should remain the version
control system (VCS) for public source, policy, migrations, and releases.
GitHub Issues can still hold development backlog and PRDs, and GitHub Actions
can still validate changes and build releases. Neither needs to sit in the
latency-sensitive path of an already installed OpenAB review run.

For the current single-maintainer, single-host scope, the recommended
operational authority is one local `openab-control` service backed by SQLite.
It can commit run state, reviewer state, an audit event, and an external-effect
plan together. SQLite is in-process and serverless, supports ACID transactions
and crash recovery, and has a stable cross-platform file format. It permits one
writer at a time, which matches a serialized local transition service but not a
multi-node control plane. [SQLite's selection guide recommends it for
device-local, low-writer-concurrency storage](https://sqlite.org/whentouse.html),
and [its transaction guarantee covers application, operating-system, and power
failures when the storage and durability settings honor SQLite's
requirements](https://sqlite.org/transactional.html).

There is one genuinely smaller option: a **single canonical JSON snapshot** can
beat SQLite if the MVP is intentionally restricted to one active run, one
writer, one compound state document, very small data, no ad-hoc queries, and no
need for a separately queryable audit/outbox history. The writer can replace
the whole snapshot through a temporary file, sync, and same-filesystem rename.
That is different from a JSONL event log plus indexes and projections. The
latter quickly recreates transaction, recovery, migration, and compaction work
that a database already provides. [Go documents `File.Sync` and the
platform-dependent semantics of `Rename`](https://pkg.go.dev/os). Given
OpenAB's reviewer executions, expiring health observations, effect
reconciliation, and audit requirements, SQLite has the safer margin today.

The MVP SQLite profile should use one process, one local persistent volume,
rollback-journal mode, and `synchronous=EXTRA`. It should **not** start with
WAL. WAL can improve read/write concurrency, but it adds `-wal` and `-shm`
state, checkpointing, same-host shared-memory requirements, and network
filesystem restrictions. If WAL is later justified, require local storage and
a SQLite build containing the WAL-reset fix (3.51.3 or a documented backport).
[The official WAL documentation describes those constraints and fixed
versions](https://sqlite.org/wal.html).

PostgreSQL is the conditional next step when the authority must survive one
host, accept writers from more than one machine, or meet an HA/PITR objective.
rqlite is a narrower conditional bridge for teams that specifically want the
SQLite data model behind a Raft/HTTP service and accept three voting nodes,
quorum recovery, and deliberate read-consistency selection. Temporal becomes
interesting only when durable timers, retries, and resumable workflows—not
storage alone—dominate the problem. etcd, NATS JetStream, Kubernetes CRDs,
object storage, Redis, and a local Git gate all have useful roles, but none is
the best primary operational record for this MVP.

No candidate makes an external API call and its local state change one atomic
operation. Discord, provider, Kubernetes, and GitHub effects still need durable
intent, idempotency keys, and reconciliation after an ambiguous timeout or
crash. Temporal reduces the amount of orchestration code, but its own guidance
still recommends idempotent Activities because retries can re-execute an
external operation. [Temporal Activity guidance](https://docs.temporal.io/activities).

Finally, the cutover must have **one write authority and no dual-write
period**. Freeze the old Git/GitHub runtime state as a read-only archive;
reconcile or close its runs; then create only new runs under the new authority.
GitHub may receive one-way, sanitized projections, but no projection may
authorize a transition or be read back as runtime truth.

## Why this is an architecture change

The legacy repository decisions said that GitHub owned Development Work Item
state, that the gate-owned Issue comment was the authoritative snapshot, and
that a separate database was rejected as a competing authority. Those legacy
ADRs were intentionally not migrated; see
[legacy provenance](../legacy/provenance.md).
Adopting this recommendation therefore requires a superseding ADR and matching
updates to `CONTEXT.md`; adding a database dependency alone would create the
dual-authority condition those ADRs were designed to prevent.

GitHub Issues may still track development backlog and PRDs, while GitHub
Actions may still validate source and build releases. They would no longer
represent the live state of an OpenAB review run. This separates slow human
software-development coordination from machine runtime transitions.

## Authority boundaries

“Source of truth” is an ownership rule, not a property conferred by a file
extension or database engine. It is scoped by **data category**; the goal is not
one store that owns source, secrets, runtime state, evidence, and configuration
at once. The proposed boundary is:

| Information | Authority | Examples | If unavailable |
| --- | --- | --- | --- |
| Source and release truth | Git commit/tag in the public repository | Go code, schemas, prompt templates, adapters, migrations, public example configuration, release metadata | New builds/releases stop; an already installed runtime may continue under its pinned revision |
| Installation configuration truth | Private host-local configuration outside the checkout, loaded and digest-pinned by the installed service | Fixed broker roster, provider routes, deployment-specific identities, allowlists, non-secret references | Startup or explicit reload fails; an already loaded immutable snapshot may continue according to policy |
| Runtime truth | One local SQLite database, mutated only through `openab-control` | Run state/version, exact target binding, reviewer execution state, health observations, idempotency, effect plans, reports, synthesis state, audit events | New transitions stop; there is no fallback write to GitHub |
| Exported evidence | Immutable per-run bundle outside the checkout | Raw responses, canonical report and synthesis, manifest, checksums, source revision, database event range | Active state is still read from SQLite; missing required evidence blocks completion/export |
| Target source truth | Target Git repository and immutable commit IDs | Base/head commits, PR, native checks | The run cannot validate or advance its target |
| Secrets | OS credential store or Kubernetes Secret boundary, depending on deployment | GitHub tokens, Discord tokens, provider credentials, private keys | The relevant external effect stops; secret values are never copied into Git, SQLite, or evidence |
| Human-facing projections | CLI/UI and optional GitHub summary | Current status, links, sanitized completion summary | No effect on runtime authority |

Git is well suited to the first row: a commit stores a snapshot of project
state, and Git objects are content-identified and immutable. [The Git glossary
defines commits as stored snapshots and objects as content-identified units](https://git-scm.com/docs/gitglossary).

**Git and GitHub are not in the recommended operational hot path.** The
installed binary and installation configuration pin a source/policy revision
at build, deployment, or explicit reload time. A normal run transition reads
the database and the already loaded configuration snapshot; it does not fetch,
pull, inspect an Issue comment, or wait for an Action. Product-level default
policy, schema, and migrations remain in public Git. A fixed MVP broker roster
can come from private local configuration. If a broker must be enabled,
disabled, or quarantined while the service is running, that mutable
administrative state belongs in the database—not in a Git registry that would
quietly remain a second runtime authority.

The legacy `registry/brokers.v1.json` (not migrated; see
[legacy provenance](../legacy/provenance.md)) contains
deployment-specific categories such as Discord bot/channel identifiers,
Kubernetes namespace/runtime identity, image digests, persistent-volume and
workspace references, secret-reference names, and a target repository ID. No
actual value is repeated here. Before the source repository becomes public,
that deployment registry must move to the private installation boundary and be
replaced, if useful, by a sanitized schema/example. Removing the current file
only protects future commits: a separate audit of Git history, forks, Actions
logs/artifacts, and previous secret exposure is a prerequisite to publication.
GitHub explicitly warns that a public conversion exposes code plus Actions
history and logs. [GitHub repository-visibility guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).
A clean public repository may be safer if history cannot be confidently
sanitized; deciding or performing that publication is outside this research.

The mutable database must live outside the working tree, for example
`$XDG_STATE_HOME/openab/control.db` on a host service or `/var/lib/openab/control.db`
inside a control Pod. `.gitignore` is only defense in depth because it affects
untracked files and does not remove an already tracked file. [Git documents that
limitation explicitly](https://git-scm.com/docs/gitignore). The repository's
existing legacy boundary checker (not migrated; see
[legacy provenance](../legacy/provenance.md)) already
uses `runtime-cache/state.db` as a prohibited/ignored fixture; a later
implementation should generalize that protection to the chosen external state
path and all database sidecar files.

## What SQLite solves

1. **Runtime latency.** A transition becomes a local transaction rather than a
   commit, workflow queue, runner startup, API round trip, and comment update.
   SQLite is explicitly designed as local application storage rather than a
   client/server service. [SQLite describes this design target and its low
   administration cost](https://sqlite.org/whentouse.html).

   In particular, a Broker health refresh becomes a local observation insert
   with an `expires_at` value; it does not create a source revision, PR, or
   workflow. Version-controlled policy still defines how health is interpreted,
   while the observation remains runtime truth, consistent with the existing
   distinction in legacy ADR 0040 (not migrated; see
   [legacy provenance](../legacy/provenance.md)).

2. **Atomic state plus audit updates.** The service can validate an expected
   `state_version`, update the current row, append the audit event, and insert an
   external-effect plan in one transaction. Successful `sql.Tx.Commit` applies
   all updates as one atomic change; failed transactions are discarded.
   [Go's official transaction guidance defines these commit semantics](https://go.dev/doc/database/execute-transactions),
   and [SQLite supports multiple readers but one concurrent write
   transaction](https://sqlite.org/lang_transaction.html).

3. **Crash recovery.** In rollback-journal mode SQLite detects a hot journal
   before reading and rolls it back to restore a consistent database.
   [The official locking documentation specifies that recovery path](https://sqlite.org/lockingv3.html#hot_journals).
   Correct durability still depends on local storage honoring locking and sync
   operations and on an appropriate `synchronous` setting.

4. **Fast offline tests and replay.** The same transition code can run against a
   temporary database without GitHub or network access. Transactions, unique
   idempotency constraints, foreign keys, and state-version predicates are
   testable in-process.

5. **Public-source/private-runtime separation.** SQLite's database file is
   portable and stable, but it need not be published. Only schema and migration
   source belongs in Git. [SQLite documents its cross-platform, backwards
   compatible database file format](https://sqlite.org/onefile.html).

6. **Consistent backups.** The Online Backup API produces a consistent
   snapshot while the source remains in use; `VACUUM INTO` is another way to
   create a compact consistent copy. [SQLite documents both backup methods](https://sqlite.org/backup.html)
   and [the durability conditions of `VACUUM INTO`](https://sqlite.org/lang_vacuum.html#vacuuminto).

## What SQLite does not solve

Unless a source is linked, the limitations in this section are architectural
deductions from placing one embedded database inside one local trust and failure
boundary.

1. **Multi-node consensus or high availability.** SQLite has one writer per
   database file. WAL readers must be on the same host and WAL does not work
   over a network filesystem. A future active/active or multi-node control plane
   needs a client/server database or a separate consensus/fencing design, not a
   shared SQLite file. [SQLite's concurrency and network guidance is explicit
   about this boundary](https://sqlite.org/useovernet.html).

2. **Exactly-once external effects.** A SQLite transaction cannot atomically
   commit a Discord post, provider invocation, Kubernetes mutation, or GitHub
   API call. The database can durably plan an effect before dispatch and record
   its result afterward, but a crash between the remote success and local
   confirmation remains ambiguous. Idempotency keys, an outbox, and explicit
   reconciliation are still required.

3. **Protection from the host owner.** A local administrator who can replace the
   database and every backup can rewrite history. An event digest chain detects
   partial alteration only when a trusted digest or signed manifest is anchored
   elsewhere. SQLite provides consistency and durability, not an adversarial
   audit ledger.

4. **Host or disk loss.** A persistent volume is not a backup. Recovery still
   needs tested snapshots stored on a separate failure boundary.

5. **Secrets management.** Database permissions do not replace Kubernetes
   Secrets, an OS credential store, or an external secret manager. Secret values
   should remain outside both database and evidence bundles.

6. **Provider and protocol correctness.** A local store does not prevent a
   reviewer from returning malformed output, a delivery adapter from using the
   wrong field names, or a runtime permission from rejecting a tool. It makes
   those failures faster to reproduce and records them consistently.

7. **Schema and driver costs.** The project must still maintain migrations,
   backups, recovery tests, and a Go driver. `database/sql` is a generic
   interface and requires a separate driver. [The standard package documents
   that boundary](https://pkg.go.dev/database/sql).

## Evaluation criteria and invariant

The alternatives are evaluated against the actual problem rather than a
generic database benchmark:

- remove GitHub Actions startup, queue, and feedback waits from runtime state
  transitions;
- keep a future public source repository separate from private runtime data and
  evidence;
- atomically protect state-machine invariants and durable effect intent;
- recover after a process, node, or disk failure with a testable procedure;
- retain useful audit history without claiming adversarial immutability;
- support the current single-person MVP without paying premature HA operations;
- expose a credible migration path if multi-machine writers or HA become real;
  and
- make external-side-effect ambiguity visible instead of promising impossible
  exactly-once behavior across unrelated systems.

The non-negotiable invariant is **one authoritative write path per authority
epoch**. A projection, export, cache, message stream, GitHub comment, or old
repository record may be readable, but it cannot also advance the run.

## Candidate landscape and ranking

The tiers below are the recommendation, not product-quality rankings. A
screened-out product may be excellent for its intended role and still be a poor
fit for OpenAB operational state.

| Rank | Candidate | Decision now | Reconsider when |
| ---: | --- | --- | --- |
| 1 | SQLite behind one local control service | **Recommended now.** Best balance of local speed, transactions, relational constraints, audit/outbox consistency, backup, and low operations | Move to PostgreSQL when the measurable multi-host/HA triggers below fire |
| 2 | One canonical JSON snapshot | **Conditional minimal alternative.** It can be smaller than SQLite only under a deliberately narrower one-run/one-writer/no-query scope | Upgrade as soon as independent outbox/audit history, multiple runs, indexes, or non-trivial migrations are required |
| 3 | PostgreSQL, self-managed or managed | **Conditional next architecture.** Same transactional class either way; managed service changes operational ownership, not consistency semantics | More than one writer host, remote availability, PITR, or host-independent RTO/RPO is required |
| 4 | rqlite | **Conditional HA bridge.** Relational SQLite over HTTP/Raft, but three voting nodes and read-consistency choices are real costs | The team specifically values SQLite/HTTP and can operate quorum, but does not want PostgreSQL |
| 5 | Temporal | **Conditional orchestration layer, not a lightweight DB substitute.** Strong fit for durable timers/retries/resume after workflow complexity becomes dominant | Several custom retry/reconciliation machines or long-lived workflows repeatedly cause defects, and operating/buying Temporal is acceptable |
| 6 | bbolt | **Narrow fallback.** Good embedded ACID KV store behind one permanent Go daemon | The SQLite driver fails the measured build gate and SQL constraints/inspection are not needed |
| 7 | etcd | **Do not use as the application database now.** Valuable for small distributed coordination metadata | A three-node etcd cluster is already operated and the problem becomes linearizable compare/watch, not relational run history |
| 8 | NATS JetStream | **Use only as transport/event distribution if later needed.** Not the transactional run authority | Consumers need replay/fan-out; the database remains authoritative |
| 9 | Local Git gate | **Bridge only.** It removes hosted runner waits but retains commit-shaped runtime churn and public-data risk | A near-zero-change interim experiment is needed before the real cutover |
| 10 | Kubernetes API/CRD | **Exclude for this data.** Kubernetes explicitly warns against using custom resources as application/end-user/monitoring storage | Only declarative, Kubernetes-coupled, small and infrequently updated desired state is modeled |
| 11 | Object store or Redis | **Exclude as primary authority.** Use object storage for evidence and Redis for disposable cache/projection | Their specialized role appears; neither should become a second writer |

### Decision matrix

`Strong`, `Adequate`, and `Weak` are this research's fit judgments derived from
the documented properties linked in the detailed sections. “Public separation”
means the design can keep private runtime data out of a public source repository
without relying on contributors to remember not to commit it.

| Candidate | Single-person MVP | Removes hosted wait | Public separation | Multi-entity atomicity | Backup/recovery | Multi-machine/HA | Operations cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Canonical JSON snapshot | **Strong under strict scope** | Strong | Strong | Adequate only when every field is one replaced document | Application protocol | Weak | **Lowest initially** |
| JSONL plus projections | Weak | Strong | Strong | Weak without custom protocol | Application protocol | Weak | Grows from low to high |
| SQLite | **Strong** | Strong | Strong | **Strong** | Strong on one host with tested off-host backups | Weak | **Low** |
| bbolt | Adequate | Strong | Strong | Strong within KV transaction; relational rules are code | Adequate | Weak | Low |
| PostgreSQL | Adequate | Strong | Strong | **Strong** | **Strong**, including optional PITR | **Strong when configured** | Medium managed; high self-managed HA |
| rqlite | Weak now | Strong | Strong | Strong SQL request/transaction | Adequate; cluster recovery required | Strong with quorum | Medium-high |
| etcd | Weak | Strong | Strong | Strong KV compare/transaction | Snapshot/cluster procedure | Strong with quorum | High for this MVP |
| NATS JetStream | Weak as authority | Strong | Strong | **No multi-operation atomic batch** | Stream-specific | Replicated quorum available | Medium-high |
| Kubernetes CRD | Weak | Strong | Strong | Object-level concurrency; no cross-object transaction | Coupled to cluster datastore | Coupled to control-plane HA | Medium and shared blast radius |
| Temporal | Weak as a first step | Strong | Strong | Durable workflow transitions; Activities remain external | Depends on Temporal Service and persistence | Strong when deployed/managed for HA | High now |
| Object store | Weak | Strong | Strong | Atomic per key, not across the run model | Strong for immutable objects | Provider-dependent | Medium |
| Redis | Adequate for cache, weak for truth | Strong | Strong | Commands can be serialized, but transactions do not roll back | Policy-dependent data-loss window | Async replication caveats | Medium |
| Git with local gate | Adequate as bridge | Removes hosted runner queue only | Conditional: strong with a separate private runtime repository; weak if mixed into public source | Commit snapshot only; remote effects still separate | Distributed clones help | Merge/ref coordination, not DB HA | Medium due to workflow ceremony and a second private repository |

| Candidate | Query/audit ergonomics | Migration burden from current model | External-effect ambiguity | Recommended role |
| --- | --- | --- | --- | --- |
| Canonical JSON snapshot | Simple whole-run inspection; weak history/query | Low only if model is shrunk first | Requires intent in the same document, idempotency, reconciliation | Ultra-small one-run prototype |
| JSONL plus projections | Raw audit readable; current views and upgrades are custom | Medium-high | Requires custom atomicity between log, projection, and outbox | Terminal evidence export |
| SQLite | SQL current view plus atomic append-only events | Medium | Requires transactional outbox/idempotency/reconciliation | **Operational authority now** |
| bbolt | Custom inspection and indexes | Medium | Same outbox pattern, application modeled | SQLite build fallback |
| PostgreSQL | Excellent relational query/audit | Medium from SQLite-compatible schema | Same outbox pattern | Conditional multi-host authority |
| rqlite | SQL over HTTP; consistency level must be explicit | Medium | Same outbox pattern | Conditional SQLite-shaped HA |
| etcd | Revision/watch history is compacted; relational reports custom | High | Same intent/reconciliation requirement | Distributed coordination metadata |
| NATS JetStream | Excellent stream replay, weak relational current state | High if made primary | At-least-once delivery requires idempotent consumers | Transport/event distribution |
| Kubernetes CRD | `kubectl` visibility; application queries awkward | High | Controller reconciliation helps but does not make remote calls atomic | Declarative Kubernetes desired state only |
| Temporal | Excellent per-workflow event history and resume | High | Activities retry; idempotency is still required | Conditional durable orchestrator |
| Object store / Redis | Object listing or key queries, not domain audit | High as primary | Same ambiguity; multi-entity atomicity missing/limited | Evidence or disposable acceleration |
| Git with local gate | Familiar diff/log but operational events become commits | Low as bridge, high long-term coupling | Same ambiguity | Temporary bridge only |

## Local file and embedded database alternatives

### Canonical snapshot versus JSONL event log

A plain-file design has two materially different forms:

1. **One canonical JSON snapshot.** A single writer serializes the complete
   authoritative state of the one active run—including pending effect intent—to
   a temporary file, syncs it, renames it over the old snapshot on the same
   filesystem, and syncs the directory. This can be the smallest correct MVP
   when the document is bounded and every invariant is validated before whole
   document replacement. It avoids a database driver, migrations can initially
   be a `schema_version` plus whole-document upgrade, and recovery chooses one
   valid old or new snapshot.
2. **JSONL events plus snapshots/projections.** Appending newline-delimited
   records is attractive for audit, but current-state queries need replay or a
   projection. The application must coordinate log append, partial-final-record
   recovery, projection update, outbox intent, snapshots, compaction, and event
   upcasting. Once those are needed, it is building a database protocol.

The canonical snapshot wins over SQLite only while all of these are true:

- at most one active run and one writer process;
- the entire authoritative state remains comfortably small enough to rewrite;
- all pending external-effect intents fit inside the same document replacement;
- no independent append-only audit retention or cross-run query is required;
- restore means selecting and validating a complete snapshot, not point-in-time
  recovery; and
- the team is willing to test the exact Linux filesystem's sync/rename behavior.

Move to SQLite when any one of the following occurs: two active runs are
allowed; effect attempts need an independently queryable history; an audit log
must be retained while current state changes; the service needs indexes or
filtered health queries; whole-file migration/rewrites exceed 100 ms at p95;
or the recovery code gains a projection, compaction, or log-repair subsystem.
Go provides `File.Sync`, `Rename`, and JSON encoding primitives, but not a
portable multi-record transaction manager. [Go `os` documentation](https://pkg.go.dev/os)
and [JSON encoder documentation](https://pkg.go.dev/encoding/json#Encoder.Encode).

### SQLite, JSONL, and bbolt comparison

Linked entries below are documented product properties. Unlinked entries are
design inferences about the work this repository would have to own.

| Criterion | SQLite | Append-only JSONL event log | bbolt (Go-native KV) |
| --- | --- | --- | --- |
| Durability and crash recovery | ACID transactions with rollback/WAL recovery when filesystem and sync requirements hold. [SQLite transactional guarantee](https://sqlite.org/transactional.html) | The application must frame records, call `File.Sync`, detect/truncate a partial final record, and define recovery. Go provides append I/O and `File.Sync`, not a transaction manager. [Go `os.File.Sync`](https://pkg.go.dev/os#File.Sync) | Serializable ACID transactions; commits use a two-phase data/meta-page write with sync. The project also documents first-initialization and filesystem caveats. [bbolt README](https://github.com/etcd-io/bbolt#caveats--limitations) |
| Multi-record invariant | One transaction can update normalized state, event audit, and outbox together. [SQLite transactions](https://sqlite.org/lang_transaction.html) | No native cross-record or cross-file transaction; snapshots, indexes, and outbox consistency are application protocols | One KV transaction is atomic, but relations and constraints are application code. [bbolt transactions](https://github.com/etcd-io/bbolt#transactions) |
| Concurrency | Multiple readers and one writer; WAL allows readers with a writer on one host. [SQLite concurrency](https://sqlite.org/lang_transaction.html) | Safest MVP is one writer; portable cross-process locking and replay/snapshot coordination must be added | One read-write transaction and many read-only transactions, but the normal database open uses an exclusive file lock and cannot be shared by multiple read-write processes. [bbolt opening and transaction rules](https://github.com/etcd-io/bbolt#opening-a-database) |
| Schema and queries | SQL tables, checks, foreign keys, indexes, and explicit migrations | Version every event; queries require replay or separately maintained projections | Buckets and byte values; indexes, encoding versions, and migrations are application-owned |
| Backup | Online snapshot or `VACUUM INTO`; do not copy only the main file from a live WAL database. [SQLite backup](https://sqlite.org/backup.html) | Rotate/close and copy segments plus projection snapshots under an application-defined protocol | A read transaction can produce a consistent hot backup with `Tx.WriteTo` or `CopyFile`. [bbolt backups](https://github.com/etcd-io/bbolt#database-backups) |
| Portability | Stable, cross-platform database file. [SQLite file format](https://sqlite.org/onefile.html) | Highest human readability and broad JSON tooling; Go's encoder can write one newline-delimited value per call. [Go JSON encoder](https://pkg.go.dev/encoding/json#Encoder.Encode) | Pure Go and one file, but the documented on-disk layout is endian-specific. [bbolt caveats](https://github.com/etcd-io/bbolt#caveats--limitations) |
| Auditability | Append-only event table plus SQL queries; hash chaining is application-level and not host-owner-proof | Naturally inspectable append history, but “append-only” and tamper evidence are application/permission properties | Requires an application event bucket and tooling |
| Best role here | Runtime authority | Evidence export and diagnostic stream | Plausible only behind one permanent daemon when relational constraints and multi-process access are unnecessary |

An append-only JSONL log looks smallest at the file level, but it moves database
work into the application: write exclusion, partial-record recovery, event
upcasting, snapshot creation, projection rebuilds, compaction, referential
checks, and outbox consistency. That is a reasonable evidence format, not the
lowest-risk runtime authority for this state machine.

bbolt is genuinely relevant because this repository is Go and the proposed
service has one logical writer. It is not selected because its exclusive
read-write process lock makes operational inspection and future local
multi-process clients harder, while the current domain has relational entities,
unique bindings, and audit queries that map directly to SQL. bbolt remains a
fallback if the SQLite driver fails the build-time acceptance threshold and the
implementation commits to one database-owning daemon.

## Client/server and distributed alternatives

### PostgreSQL: the conditional next architecture

PostgreSQL supplies the same essential invariant that motivates SQLite: a
transaction groups multiple changes so they are visible together or not at all.
Its MVCC design also lets reads and writes proceed without the single-file
ownership boundary of an embedded database. [PostgreSQL's transaction tutorial](https://www.postgresql.org/docs/current/tutorial-transactions.html)
and [MVCC introduction](https://www.postgresql.org/docs/current/mvcc-intro.html).
Primary keys, unique constraints, checks, and foreign keys can keep run,
reviewer, effect, and event relationships inside the database boundary.
[PostgreSQL constraint documentation](https://www.postgresql.org/docs/current/ddl-constraints.html).

It also has a clearer growth path for recovery. Write-ahead logging supports
crash recovery; a base backup plus archived WAL enables point-in-time recovery.
That capability is powerful but requires archive retention, restore procedures,
and monitoring. [PostgreSQL WAL introduction](https://www.postgresql.org/docs/current/wal-intro.html),
[backup overview](https://www.postgresql.org/docs/current/backup.html), and
[continuous archiving/PITR](https://www.postgresql.org/docs/current/continuous-archiving.html).

“Managed PostgreSQL” and “self-managed PostgreSQL” are one architectural class
for this decision. Both expose PostgreSQL's transaction model. A managed
provider may operate backups, patching, replicas, and failover, but its exact
RPO/RTO and restore responsibility are service-contract questions. Self-hosting
those capabilities means OpenAB must operate them. Streaming replication is
asynchronous by default, so a primary failure can lose transactions not yet
received by a standby; synchronous replication trades latency for stronger
confirmation. [PostgreSQL standby documentation](https://www.postgresql.org/docs/current/warm-standby.html).

PostgreSQL is not recommended merely because it is “more production.” Choose it
when at least one measurable trigger in the decision-trigger section fires.
Until then, a server process, credentials, network path, upgrades, and backup
operations are overhead with no user-visible benefit over local SQLite.

### rqlite: distributed relational SQLite as a narrow bridge

rqlite exposes a SQLite-backed relational database through an HTTP API and
puts every write through a Raft log; only changes committed by a quorum are
applied. A three-voting-node cluster can tolerate one node failure. [rqlite API
documentation](https://rqlite.io/docs/api/api/) and [cluster-size
guidance](https://rqlite.io/docs/clustering/general-guidelines/).

That is real HA, not a shared SQLite file, but it is not “SQLite with no extra
work.” The application must connect through HTTP, nodes must maintain quorum,
snapshots and failed membership require operations, and network latency enters
the write path. Reads also require a deliberate choice: rqlite's default
`weak` mode can briefly return stale data around leadership changes;
`linearizable` contacts a quorum and costs latency. Its documentation says
`strong` reads go through Raft and should not be used in production code.
[rqlite read-consistency documentation](https://rqlite.io/docs/api/read-consistency/).

For the single-host MVP, three nodes—especially three Pods on one physical
machine—add quorum complexity without removing the host failure domain. rqlite
is worth a focused comparison only if the future requirement is relational
SQLite semantics over HTTP with independently failed hosts. If ordinary SQL
tooling, managed HA, PITR, and ecosystem familiarity matter more, PostgreSQL is
the clearer next step.

### etcd: excellent coordination store, poor MVP application database

etcd offers linearizable reads by default, a globally ordered revision, watches,
leases, and atomic compare/then/else transactions over multiple KV requests.
Those are strong primitives for distributed locks, leader election, and small
control-plane metadata. [etcd's v3 API documentation](https://etcd.io/docs/v3.7/learning/api/)
and [API guarantees](https://etcd.io/docs/v3.7/learning/api_guarantees/).

They do not provide the relational schema, constraints, ad-hoc reporting, or
long audit retention that OpenAB would otherwise implement in application
code. etcd history is intentionally compacted; snapshots, defragmentation,
quorum recovery, disk latency, monitoring, and membership are operator duties.
[etcd disaster-recovery guidance](https://etcd.io/docs/v3.7/op-guide/recovery/)
and [hardware guidance](https://etcd.io/docs/v3.7/op-guide/hardware/).
Running another consensus system for one local writer is therefore a net
increase in risk. Reconsider etcd only if OpenAB becomes multiple distributed
controllers coordinating small metadata and a healthy etcd cluster is already
an accepted platform dependency.

### NATS JetStream: durable transport, not the state transaction

JetStream provides persisted and replicated streams, ordered messages, replay,
and acknowledgements. That makes it useful if later consumers need event
fan-out or independent replay. It should not replace the database transaction:
the official documentation states that JetStream does not atomically batch
multiple operations; the atomic unit is one stream operation. Base delivery is
at least once, so publishers and consumers must tolerate duplicates.
[NATS JetStream concepts](https://docs.nats.io/nats-concepts/jetstream).

Durability also has a configuration-dependent edge. File streams flush writes
to the OS but, by default, `fsync` no later than a two-minute `sync_interval`.
An operating-system or power failure can therefore lose a recently
acknowledged message, even though a `nats-server` process crash alone normally
does not. `sync_interval: always` plus replication gives stronger durability at
the slowest performance. The same official JetStream page documents this
tradeoff. NATS can later carry a projection emitted from the authoritative
database outbox; it should not force run state, audit, and effects into separate
message transactions.

## Platform API and workflow-engine alternatives

### Kubernetes API and CRDs

The Kubernetes API already offers authentication, authorization,
`resourceVersion`-based optimistic concurrency, watches, and declarative
reconciliation. That makes a CRD tempting because OpenAB runs on k3s.
[Kubernetes API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/#resource-versions).

The Kubernetes project explicitly says to avoid using a Custom Resource as
storage for application, end-user, or monitoring data. Its own suitability
guidance describes declarative APIs as relatively small, infrequently updated
objects that do not require transactions across objects; high-bandwidth data,
operation IDs, and application data are warning signs. Too many custom
resources can also overload API-server storage. [Kubernetes Custom Resource
guidance](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/).

OpenAB run attempts, raw/reconciled effects, provider responses, and health
observations match the warned-against application-data shape. Putting them in
CRDs would also couple application availability, backup, and load to the k3s
control plane. A small CRD could still describe desired deployment policy in a
future operator; it should not hold operational run history.

K3s does not change that conclusion. K3s uses SQLite as its default **cluster
datastore**, but its documentation states SQLite cannot be used for a cluster
with multiple server nodes; multi-server configurations use embedded etcd or
an external datastore. [K3s datastore options](https://docs.k3s.io/datastore).
Embedded etcd HA requires an odd number of at least three server nodes and
quorum, with storage performance requirements. [K3s embedded-etcd HA
guidance](https://docs.k3s.io/datastore/ha-embedded). This boundary describes
K3s's control-plane store, not permission for OpenAB to open or share that
database. OpenAB should own a separate application store and failure policy.

### Temporal: durable workflow orchestration

A Temporal Workflow Execution persists progress and can resume from its event
history after failures, with no imposed duration; timers, retries, and waiting
are first-class rather than custom state-machine polling. [Temporal Workflow
Execution overview](https://docs.temporal.io/workflow-execution). That directly
addresses a future world with many long-lived reviewer workflows, multi-stage
timeouts, and repeated crash-recovery code.

It is not a lightweight local database. A Temporal application includes the
Temporal Service, Worker processes, task queues, and a persistence store. The
project's architecture explicitly says users either operate the server and its
database or use Temporal Cloud. [Temporal server architecture](https://github.com/temporalio/temporal/blob/main/docs/architecture/README.md).
It also imposes deterministic Workflow-code rules and safe deployment/versioning
discipline.

External effects remain separate Activities. Temporal records their results and
retries failures, but recommends idempotent Activity code; an Activity attempt
may have succeeded remotely before its completion event was persisted.
[Temporal Activities](https://docs.temporal.io/activities). Temporal therefore
reduces custom orchestration and reconciliation plumbing; it does not turn a
Discord or provider API into part of one ACID transaction. Adopt it only after
the workflow-complexity triggers below fire, and then decide whether its event
history is the workflow authority while a relational store remains the domain
query/evidence index. Do not add it simply to replace GitHub comments.

## Screened-out primary stores and useful secondary roles

### Object storage

An object store is an excellent destination for immutable evidence, raw model
outputs, reports, manifests, and off-host backups. Amazon S3, as the
representative service, provides strong read-after-write consistency and atomic
updates to one key. Its conditional writes use `If-Match`/`If-None-Match` on a
specific object. [S3 consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/)
and [conditional-write guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).

Those per-object properties do not provide one transaction across run state,
reviewer state, audit, and an outbox record. Storing the entire run in one object
would recreate the canonical-snapshot design with network latency and cloud
credentials; splitting it across objects requires application coordination.
Use object storage behind terminal evidence export or backup, not as the active
operational authority.

### Redis

Redis transactions serialize queued commands, but Redis deliberately does not
support transaction rollback. Durability is configuration-dependent: the
default every-second AOF policy can lose about one second of writes, and RDB
snapshots can lose a larger interval. Replication is asynchronous by default;
even `WAIT` does not turn a deployment into a strongly consistent CP system and
acknowledged writes can still be lost on failover depending on persistence.
[Redis transactions](https://redis.io/docs/latest/develop/using-commands/transactions/),
[persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/),
and [replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/).

Redis can accelerate ephemeral views, rate limits, or leases when loss is
acceptable. Configuring it to approach a primary database's durability and HA
adds operations while still giving weaker relational/audit ergonomics for this
model. It is screened out as the operational SSOT.

### Keep Git, but move gate execution local

A local gate would remove GitHub-hosted runner queue and startup time while
retaining the current commit/comment lifecycle. It is the smallest bridge if
the team wants to measure how much delay comes from hosted Actions before an
authority cutover. It does not remove commit, branch, merge, and ref
coordination from machine state changes, and it encourages private runtime data
to approach a repository intended to become public.

This is not an inherent Git privacy failure. A completely separate private
runtime repository can keep public source and private state cleanly separated.
The cost is retaining another repository, push/backup access, commit and ref
ceremony, and the temptation to make remote availability part of each
transition. It is technically valid, but it does less to simplify the current
single-person loop than a host-local snapshot or SQLite service.

Git remains valuable precisely because it is a distributed VCS: a clone
normally mirrors repository history, so source history is easy to reproduce.
[Pro Git describes distributed clones](https://git-scm.com/book/en/v2/Getting-Started-About-Version-Control).
That is not the same as a tamper-proof operational audit. Branch refs move;
reflogs are local and expire by default after 90 days (30 days for unreachable
entries); garbage collection prunes unreachable objects. [Git reflog](https://git-scm.com/docs/git-reflog)
and [garbage collection](https://git-scm.com/docs/git-gc). Signed, protected
remote history can raise the bar, but the current runtime still pays VCS
workflow latency without gaining cross-system effect atomicity.

Public-source separation is also a hard boundary, not a `.gitignore` habit.
GitHub warns that changing a private repository to public exposes the code,
activity, and Actions history/logs to everyone; repository history and forks
have additional visibility consequences. [GitHub repository-visibility
guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).
Workflows from public forks do not receive sensitive secrets by default and may
require approval, which protects credentials but does not make published logs
or committed runtime evidence private. [GitHub Actions repository settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).
Therefore public source contains code, public schemas, examples, and releases;
private runtime data/evidence stays in a separate state and backup boundary.

## Cross-system effect ambiguity applies to every candidate

The core failure window is independent of database brand:

```text
commit durable effect intent
          |
          v
call Discord / provider / Kubernetes / GitHub
          |
          +---- remote system succeeds
          |
          X---- process or network fails before local confirmation
```

After the `X`, the controller cannot infer from its local store whether the
remote effect happened. Retrying blindly may duplicate it; assuming success may
drop it. The minimum design for SQLite, PostgreSQL, rqlite, bbolt, etcd, files,
and workflow engines is:

1. commit a stable effect ID and idempotency key with the state transition;
2. call the remote service outside the local transaction;
3. record the returned external reference when known;
4. classify unknown outcomes as `UNCERTAIN`, never silently as failed; and
5. reconcile by querying the remote system or requesting human disposition
   before another non-idempotent attempt.

An outbox gives “durable at least once intent,” not universal exactly once.
Where a provider accepts caller-supplied idempotency keys, use the stable effect
ID. Where it does not, record a fingerprint and queryable remote reference. This
is a domain/API design requirement and should be tested with injected crashes.

## Recommended runtime shape

```text
 Public Git repository                   Installed OpenAB on one host
 [code / defaults / schema]              +----------------------------+
          | build/deploy                  | openab-control             |
          v                               | [only runtime writer]      |
 binary + pinned source revision -------->|       |                    |
                                          |       v                    |
 Private installation config ------------>| loaded immutable config   |
 [fixed roster/routes/allowlists]         |       | digest             |
                                          |       v                    |
 CLI / operator API --------------------->| host-local control.db      |
 Reviewer adapters <--- planned effects---| outside the checkout       |
                                          +-------------+--------------+
                                                        |
                                                        | terminal export
                                                        v
                                          private evidence bundle
                                          [JSONL + artifacts + SHA-256]

 Per-transition Git/GitHub lookup --------X
 GitHub runtime write --------------------X
 Optional sanitized GitHub summary <------ one-way projection only
```

Operational rules:

- Prefer a normal `openab-control` service on the current host for the smallest
  MVP. k3s is a deployment option, not an SSOT prerequisite. This avoids making
  Kubernetes control-plane and Pod health an unnecessary dependency of each
  review transition.
- Run one database-owning process. The service, not reviewers, helper jobs, or
  direct CLI SQL access, owns the database write path.
- Put `control.db`, artifacts, and installation configuration in separate
  host-local paths outside the Git checkout, with least-privilege filesystem
  permissions. Do not use NFS, SMB, or a general network share. SQLite warns
  that network filesystem locking and sync behavior can cause corruption.
  [SQLite network filesystem guidance](https://sqlite.org/useovernet.html).
- Keep database access on the storage node. Remote clients call the control API;
  they do not mount or open the file.
- Load and validate the private installation configuration at startup or an
  explicit audited reload. Store its digest with each run. Do not read the
  public repository on every transition. Put runtime enable/disable/quarantine
  state in SQLite so a static broker file does not become a hidden writer.
- Start in rollback-journal mode. For the low-volume MVP, reduced operational
  complexity matters more than concurrent read/write throughput. Set
  `synchronous=EXTRA` for the strongest documented rollback-mode durability,
  enable `foreign_keys=ON` on every connection, and use a bounded busy timeout.
  [SQLite documents the durability matrix](https://sqlite.org/pragma.html#pragma_synchronous)
  and [requires applications to enable foreign keys rather than rely on the
  default](https://sqlite.org/pragma.html#pragma_foreign_keys).
- Use one short-lived transaction per state transition. With Go's connection
  pool set to one open connection for the MVP, all access is serialized; Go
  documents that `SetMaxOpenConns` makes excess operations wait like a lock, so
  transaction code must not recursively request another connection.
  [Go connection-pool guidance](https://go.dev/doc/database/manage-connections)
- Never make a remote call while holding a database transaction. Commit an
  effect plan first, dispatch afterward, then confirm in a new transaction.
- On startup, refuse to serve writes until migrations, foreign-key checks, and
  an integrity check succeed. `PRAGMA integrity_check` checks low-level database
  consistency, while `PRAGMA foreign_key_check` is needed separately.
  [SQLite integrity-check documentation](https://sqlite.org/pragma.html#pragma_integrity_check)

If k3s is chosen later for packaging or supervision, run exactly one replica,
use host-local single-writer (`RWO`) storage, pin scheduling to the storage node,
and use a recreate-style handoff so two Pods never open the same database.
Backups must leave that node's failure boundary. A `ContainerStatusUnknown`
episode is a service-availability incident, not a reason to let another Pod
take unfenced ownership or fall back to GitHub. If the service must continue
through node loss, that is a PostgreSQL/rqlite/HA trigger rather than a shared
SQLite-volume workaround.

### WAL is an optional later optimization

Do not enable WAL just because it is commonly recommended for web applications.
If measured contention later justifies it, require all of the following:

1. the database, writer, readers, `-wal`, and `-shm` files remain on the same
   physical host and local filesystem;
2. backup uses the SQLite backup API or a controlled checkpoint/close rather
   than copying only `control.db`, because the WAL is part of persistent state;
3. checkpoint growth and long-lived readers are monitored;
4. `synchronous=FULL` is used if the latest committed transition must survive a
   power loss; `NORMAL` preserves consistency but can lose a recent committed
   transaction after power loss; and
5. the embedded SQLite version is 3.51.3 or later, or one of the official
   backports containing the 2026 WAL-reset fix.

All five points come directly from [SQLite's WAL documentation](https://sqlite.org/wal.html).

### Go driver gate

Use `database/sql` so the store boundary is testable, but treat driver selection
as a measured implementation choice. The first spike should evaluate
`modernc.org/sqlite` because it is CGo-free and its current v1.56.0 package
documents SQLite 3.53.3 across the relevant Linux architectures. The project
also warns that its `modernc.org/libc` version must match, so both modules must
remain pinned. [Project-owned driver documentation](https://pkg.go.dev/modernc.org/sqlite).

This is a candidate, not a reason to accept slower builds. Phase 1 below rejects
the candidate if it violates the repository's build budget.

## Minimal data model

This is intentionally a run-oriented MVP, not a port of every Claim, Lease,
Capacity Index, and GitHub projection table.

| Table | Essential fields | Invariants |
| --- | --- | --- |
| `runs` | `run_id`, `state`, `state_version`, `product_revision`, `installation_config_digest`, `target_repository_id`, `base_commit`, `head_commit`, `input_digest`, timestamps | Exact immutable target and installed-policy/config binding; compare-and-swap on `state_version`; one terminal state |
| `broker_runtime_states` (optional when hot administration is enabled) | `broker_id`, `state`, `state_version`, optional reason/expiry, updated actor/time | Only mutable enable/disable/quarantine state; `broker_id` must resolve in the loaded private installation configuration |
| `reviewer_executions` | `execution_id`, `run_id`, `reviewer_id`, `provider`, `model_profile_revision`, `state`, `raw_artifact_id`, `report_artifact_id`, timestamps | Unique `(run_id, reviewer_id)`; independent reviewer state; output cannot bind another run |
| `health_observations` | `observation_id`, `broker_id`, `status`, `observed_at`, `expires_at`, `evidence_artifact_id` | Expired observation means unknown; health never grants authority |
| `effects` | `effect_id`, `run_id`, optional `execution_id`, `kind`, unique `idempotency_key`, `state`, `request_json`, `external_ref`, attempt timestamps/error | Plan committed before dispatch; an in-flight effect after a crash becomes `UNCERTAIN` and is reconciled, never blindly replayed |
| `artifacts` | `artifact_id`, `run_id`, `kind`, `media_type`, `sha256`, byte length, inline content or content-addressed relative path, timestamp | Digest verified on read/export; external paths cannot escape the private artifact root |
| `events` | monotonic `sequence`, `event_id`, `run_id`, entity kind/ID, event type, actor, `recorded_at`, canonical payload, previous/current digest | Insert-only through the store API; current-row update, event, and effect plan share one transaction |
| `schema_migrations` | version, name, checksum, applied timestamp | One immutable checksum per applied version; no automatic downgrade |

Current-state tables and the event table are one authority inside one database.
The MVP should not require replaying the entire event history to answer current
state; events are the append-only audit projection written atomically with the
normalized rows. A digest chain helps detect accidental or partial modification
but becomes meaningful against a malicious rewrite only after a trusted terminal
manifest digest is copied to another failure/authority boundary.

The static broker roster, routes, and deployment bindings do not need to be
duplicated wholesale into SQLite. They remain authoritative in one private
installation-config snapshot that is loaded explicitly. Each run records its
digest and the resolved broker/execution binding needed to reproduce that run.
`broker_runtime_states` exists only because an operator may need to disable or
quarantine a broker without editing/reloading a file. If runtime mutation is
not required in the first spike, omit that table and require a restart for a
roster change; do not keep the public Git registry as an implicit fallback.

The transition pattern is:

```text
 receive command with expected state_version and idempotency key
                           |
                           v
                    begin transaction
                           |
             validate current state and bindings
                           |
             update normalized current-state row
             append event
             insert effect plan (when needed)
                           |
                         commit
                           |
              dispatch planned effect outside DB
                           |
        confirm result or record UNCERTAIN for reconciliation
```

## What remains outside the database

- Git source, migrations, public schemas, prompt templates, and example
  configuration remain in the repository.
- Actual deployment bindings that would make a public repository disclose the
  maintainer's infrastructure remain in an external config file or Kubernetes
  ConfigMap; only their non-secret schema/example is public.
- Credentials and private keys remain in the secret boundary and are referred
  to by logical name only.
- Target clones, worktrees, PVC contents, model homes, caches, and build output
  remain disposable filesystem/runtime resources.
- Large target diffs or attachments remain in a private content-addressed
  artifact directory; SQLite stores their path, size, media type, and digest.
- Each terminal run is exported to an immutable private evidence directory with
  a versioned manifest, JSONL events, raw reviewer output, canonical reports,
  synthesis, source/target commit IDs, and SHA-256 checksums. A sanitized summary
  may be projected to GitHub, but raw environment identifiers or confidential
  content must not be published automatically.

For filesystem artifacts, write to a temporary file, call `File.Sync`, rename
within the same filesystem, sync the parent directory on the supported Linux
filesystem, and only then commit the database reference. Go documents that
`File.Sync` flushes current file content to stable storage and warns that
`Rename` has OS-specific atomicity restrictions, so the exact file-and-directory
protocol must be tested rather than presented as universally atomic.
[Go `os` documentation](https://pkg.go.dev/os).

## Migrations, backup, and recovery

### Schema migrations

- Store numbered SQL migrations in Git and embed them in the binary with
  `go:embed`; Go guarantees embedded files come from the package tree at build
  time. [Go `embed` documentation](https://pkg.go.dev/embed)
- Record the application migration level in `PRAGMA user_version` and record
  each migration name/checksum in `schema_migrations`. SQLite reserves
  `user_version` for application use. [SQLite `user_version`](https://sqlite.org/pragma.html#pragma_user_version)
- Apply forward migrations under exclusive startup ownership, inside a
  transaction where SQLite permits it. Refuse to open a database newer than the
  binary.
- Create and verify a backup before migration. For structural changes beyond
  SQLite's direct `ALTER TABLE` subset, follow its documented transactional
  table-rebuild procedure rather than editing `sqlite_schema` casually.
  [SQLite `ALTER TABLE` guidance](https://sqlite.org/lang_altertable.html)

### Backup policy

- Take a consistent backup after each terminal run, before every migration, and
  on a simple time-based schedule while active work exists.
- Use the Online Backup API or `VACUUM INTO`; never `cp control.db` while a WAL
  connection is live.
- Store at least one encrypted backup outside the k3s node's disk failure
  boundary. Do not put backups in the public repository.
- Run `integrity_check` and `foreign_key_check` against the produced backup,
  record its SHA-256 and schema version, and periodically perform a restore drill.
- Recovery stops the writer, restores one verified snapshot, reopens through the
  normal migration path, and marks any previously in-flight external effect
  `UNCERTAIN` until remote evidence is reconciled.

SQLite's Backup API creates a consistent snapshot and permits incremental copy
with brief source read locks; `VACUUM INTO` creates a compact consistent copy but
an interrupted output may be incomplete. [Official backup guidance](https://sqlite.org/backup.html)
and [official `VACUUM INTO` guidance](https://sqlite.org/lang_vacuum.html#vacuuminto).

## Migration without dual writes

The migration is an authority cutover, not a synchronization project. Do not
build GitHub-to-database and database-to-GitHub writers that both remain active.

### Before the cutover

1. Approve a superseding architecture decision and assign an
   `authority_epoch`/`cutover_id`. Record the old Git revision, new product
   revision, new schema version, installation-config digest, and planned UTC
   boundary.
2. Move deployment-specific broker configuration to the private installation
   boundary. Complete the separate source-history, fork, Actions-log/artifact,
   and secret-exposure audit before any public-repository conversion. This
   research does not authorize publication.
3. Inventory every non-terminal old run and external effect. Finish, cancel, or
   manually reconcile it under the **old** authority. Do not migrate a live
   half-completed run unless a separate, run-specific procedure is reviewed.
4. Disable creation and transition triggers in the old Git/GitHub runtime path.
   Preserve development CI and source validation; disable only operational
   state mutation.

### At the boundary

1. Export the old authoritative snapshots, Issue/comment links, relevant
   workflow metadata, and known evidence into a read-only archive with a
   manifest and checksums. The archive remains historical evidence, not a
   runnable writer.
2. Initialize the new database from versioned migrations. Do not continuously
   mirror old mutable state. If historical summaries are imported for search,
   tag them with the old epoch and make them immutable.
3. Verify that the old runtime triggers are disabled, the new service has one
   writer, the schema/integrity checks pass, the private config digest matches,
   and no run ID or effect ID can be accepted by both authorities.
4. Create the first **new** run only in the database. Every database row,
   evidence manifest, and optional projection carries the new authority epoch.

### After the boundary

- GitHub receives only one-way sanitized projections dispatched from the
  database outbox. Projection failures cannot roll back or authorize runtime
  transitions. No code parses a projection back into authority.
- The old Git/GitHub state stays read-only. A late webhook or rerun from the old
  epoch must be rejected and audited.
- Before the first new run, rollback may re-enable the old system because no new
  authority state exists. After the first new run, “rollback” means restore or
  repair the database/service. Re-enabling the old writer would create split
  brain; moving authority again requires a new explicit epoch and cutover.
- If an exceptional live-run import is unavoidable, freeze the old writer,
  reconcile every effect, perform one audited import, validate it, and only then
  enable the new writer. Never write the imported run back to the old system.

## Measurable decision triggers

These are proposed engineering gates for this project, not vendor limits. They
turn “maybe later” into observable decisions.

### Canonical JSON snapshot to SQLite

Choose or move to SQLite when any condition becomes true:

- two active runs are permitted, or two independently updated entities must be
  queried without loading the entire snapshot;
- effect attempts, audit events, or health observations require retained,
  filtered history;
- the design adds a second file/projection that must stay atomic with current
  state;
- p95 whole-snapshot replacement exceeds 100 ms in the offline test;
- recovery requires partial-log repair, compaction, or rebuilding an index; or
- more than one schema migration needs custom per-version recovery logic.

### SQLite to PostgreSQL

Evaluate PostgreSQL when any condition becomes true; adopt it only after a
restore/failure spike proves the stated objective:

- more than one control-service writer host is required;
- operations must continue automatically after loss of the SQLite host;
- the agreed host-loss objective is RTO of 15 minutes or less or RPO of 5
  minutes or less and the tested SQLite backup/restore design cannot meet it;
- online point-in-time recovery becomes a requirement;
- two consecutive restore drills miss the agreed RTO/RPO;
- after bounded-transaction tuning, `SQLITE_BUSY` affects more than 0.1% of
  transition attempts or p95 transaction latency exceeds 100 ms for seven days;
  or
- a supported managed database is already an accepted dependency and removes
  more operator work than it adds.

Database size alone is not a trigger. Remote users should still call the
control API rather than open a database directly. Managed PostgreSQL must have
documented backup retention, restore test, failover mode, region/failure
boundary, RPO/RTO, and exit/export path before selection.

### SQLite to rqlite

Evaluate rqlite instead of PostgreSQL only when all are true:

- relational SQLite compatibility and an HTTP API are explicit priorities;
- at least three independent failure hosts are available (three Pods on one
  host do not qualify);
- the team accepts quorum membership, snapshot, and recovery operations;
- clients explicitly request `linearizable` reads where stale decisions are
  unsafe; and
- a failure exercise demonstrates one-node loss without lost acknowledged
  writes and a documented loss-of-quorum recovery.

### Add Temporal

Run a Temporal prototype when any two workflow-complexity signals occur and the
team accepts either Temporal Cloud or operating its service and persistence:

- three or more independently implemented timer/retry/reconciliation loops
  exist in the controller;
- workflows routinely remain open longer than 24 hours across deployments;
- two or more incidents in 90 days are caused by resume, timer, or retry-state
  defects rather than provider defects;
- compensation or human-wait branches make the same workflow span five or more
  durable stages; or
- custom replay/recovery code exceeds the domain-transition code it supports.

Temporal does not replace the external-effect idempotency gate, and it need not
replace the evidence store or relational reporting model.

### Add etcd or NATS only for their intended roles

- Consider etcd when multiple controllers genuinely need distributed
  linearizable compare/watch/lease metadata and a supported three-node cluster
  is already operated. Keep run/evidence history elsewhere.
- Consider NATS JetStream when at least two independent consumers need durable
  fan-out or stream replay. Emit after the database commit and make consumers
  idempotent; never declare the stream a second authority.
- Keep Kubernetes CRDs limited to small, declarative Kubernetes desired state;
  application run data does not acquire a reconsideration trigger.
- Time-box a local Git gate only as a bridge measurement. If it persists beyond
  one migration milestone, record the private-runtime-repository operations and
  decide explicitly whether they are worth keeping.

## Phased validation and stop conditions

No phase below authorizes a live canary. A live external pilot requires a later,
explicit maintainer decision.

### Phase 0 — authority decision

Produce a superseding ADR that narrows the MVP to local review runs and makes
GitHub runtime views projections only.

Proceed only if:

- one local control process and one local storage node are acceptable; and
- Claims, renewable Leases, Capacity Index, and GitHub-comment canonicalization
  are explicitly deferred rather than silently reimplemented.

Stop and select a client/server design instead if active multi-node writers,
automatic failover, or direct cross-host database access is a current
requirement.

### Phase 1 — offline storage spike

Implement only migrations, the store interface, one run transition, one event,
one effect plan, backup, and restore. Use temporary local files and no GitHub,
Discord, provider, or Kubernetes calls.

Proposed acceptance thresholds:

- 1,000 injected process-termination/reopen iterations yield either the complete
  old state or complete new state, never a mixed state;
- duplicate idempotency submissions create exactly one effect plan;
- backup restore reproduces the same logical rows and artifact digests and
  passes both integrity checks;
- median local transition latency is below 100 ms; and
- the candidate driver adds no more than 30 seconds to a clean repository build
  and no more than 5 seconds to a warm affected-package test on the maintainer's
  machine.

Stop if any committed transition disappears after an application crash, any
mixed state appears, recovery requires editing the database manually, or the
driver exceeds the build budget. A build-budget failure triggers a bounded
driver/bbolt comparison; it does not justify returning runtime state to GitHub.

### Phase 2 — deterministic replay of existing evidence

Replay the already captured canary fixtures and provider responses into the new
store without sending external messages. Export the same run twice from restored
copies.

Proceed only if both exports have the same canonical records and digests and the
known failed run remains failed without invented completion. Stop on duplicate
reviewer executions, ambiguous target bindings, missing evidence, or
non-deterministic canonical output.

### Phase 3 — fake-adapter end-to-end test

Run two fake reviewers through the local outbox and inject crashes immediately
before dispatch, immediately after simulated remote success, and before local
confirmation.

Proceed only if pre-dispatch crashes are safely retryable by idempotency key and
post-dispatch ambiguity becomes `UNCERTAIN` and requires reconciliation. Stop if
startup automatically replays an uncertain effect or if one reviewer can satisfy
another reviewer's record.

### Phase 4 — one explicitly approved local pilot

Only after a separate maintainer approval, run one bounded external review with
SQLite authoritative and GitHub runtime writes disabled. Cap this phase at one
run and review its database, evidence export, elapsed time, and recovery notes
before any next run.

Stop immediately on database integrity failure, backup failure, missing artifact,
target mismatch, unexplained external effect, or uncertain effect that cannot be
reconciled. Do not automatically start another canary and do not fall back to a
GitHub comment as authority.

## Recommendation

Adopt SQLite as the single-maintainer operational SSOT, subject to the offline
driver/build spike. Prefer a normal one-process host service with host-local
state outside the checkout. k3s may package it later, but is not a prerequisite.
Use rollback journal with `synchronous=EXTRA`, transactional current state plus
audit events and outbox plans, tested off-host backups, and private evidence
exports.

If the maintainer intentionally reduces the first prototype to exactly one
active run, one compound document, no history query, and no independent outbox,
a canonical JSON snapshot is a defensible smaller experiment. The current
reviewer/health/effect/audit model already crosses that threshold, so SQLite is
the recommendation. Use JSONL for terminal evidence, not as a primary log plus
custom projections. Use bbolt only if the SQLite driver fails the build gate and
the project accepts single-daemon KV modeling. Do not enable WAL until measured
contention justifies its extra operational rules.

Keep Git as the public product VCS, not the operational hot path. Installed code
and private installation configuration pin their revisions/digests; transitions
do not fetch Git or GitHub. Move deployment-specific registry data out of the
public tree, put optional hot broker administration in SQLite, and perform a
separate history/log/secret exposure audit before any public conversion.

Use PostgreSQL when multi-host/HA/PITR triggers fire. Consider rqlite only for a
specific three-host SQLite-over-HTTP/Raft preference, and Temporal only after
durable-workflow complexity—not fashionable infrastructure—crosses its measured
gate. Keep etcd for distributed coordination, JetStream for transport, object
storage for evidence/backups, Redis for disposable acceleration, and CRDs for
small declarative Kubernetes state. A separate private Git runtime repository
is technically valid as a bridge, but retains the ceremony the change is meant
to remove.

Cut over with no dual-write interval: freeze and archive the old Git/GitHub
authority, reconcile its runs, then create new runs only under a new database
authority epoch. Optional GitHub summaries are one-way projections. No live
canary or publication is authorized by this document.

Most importantly, do not migrate the current enterprise lifecycle table by
table. The database is useful here because it supports a smaller MVP control
loop. Recreating every GitHub Claim, Lease, capacity, reconciliation, and
projection mechanism locally would preserve the complexity while merely moving
where it waits.

## Sources

All product-property citations are official project or vendor documentation;
the rankings and proposed thresholds are this research's architectural
inferences.

- [SQLite: Appropriate Uses](https://sqlite.org/whentouse.html)
- [SQLite Is Transactional](https://sqlite.org/transactional.html)
- [SQLite Transaction Syntax and Concurrency](https://sqlite.org/lang_transaction.html)
- [SQLite Write-Ahead Logging](https://sqlite.org/wal.html)
- [SQLite Over a Network](https://sqlite.org/useovernet.html)
- [SQLite File Locking and Crash Recovery](https://sqlite.org/lockingv3.html)
- [SQLite Backup API](https://sqlite.org/backup.html)
- [SQLite PRAGMA Reference](https://sqlite.org/pragma.html)
- [SQLite ALTER TABLE](https://sqlite.org/lang_altertable.html)
- [SQLite Single-file Cross-platform Database](https://sqlite.org/onefile.html)
- [Go: Executing Transactions](https://go.dev/doc/database/execute-transactions)
- [Go: Managing Database Connections](https://go.dev/doc/database/manage-connections)
- [Go standard library: `database/sql`](https://pkg.go.dev/database/sql)
- [Go standard library: `os`](https://pkg.go.dev/os)
- [Go standard library: `encoding/json`](https://pkg.go.dev/encoding/json)
- [modernc.org/sqlite project documentation](https://pkg.go.dev/modernc.org/sqlite)
- [bbolt project documentation](https://github.com/etcd-io/bbolt)
- [PostgreSQL: Transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- [PostgreSQL: MVCC](https://www.postgresql.org/docs/current/mvcc-intro.html)
- [PostgreSQL: Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL: WAL](https://www.postgresql.org/docs/current/wal-intro.html)
- [PostgreSQL: Backup](https://www.postgresql.org/docs/current/backup.html)
- [PostgreSQL: Continuous Archiving and PITR](https://www.postgresql.org/docs/current/continuous-archiving.html)
- [PostgreSQL: Warm Standby](https://www.postgresql.org/docs/current/warm-standby.html)
- [rqlite: API and Raft Writes](https://rqlite.io/docs/api/api/)
- [rqlite: Read Consistency](https://rqlite.io/docs/api/read-consistency/)
- [rqlite: Cluster Guidelines](https://rqlite.io/docs/clustering/general-guidelines/)
- [etcd v3.7 API](https://etcd.io/docs/v3.7/learning/api/)
- [etcd v3.7 API Guarantees](https://etcd.io/docs/v3.7/learning/api_guarantees/)
- [etcd v3.7 Disaster Recovery](https://etcd.io/docs/v3.7/op-guide/recovery/)
- [etcd v3.7 Hardware Recommendations](https://etcd.io/docs/v3.7/op-guide/hardware/)
- [NATS JetStream Concepts and Durability](https://docs.nats.io/nats-concepts/jetstream)
- [Kubernetes: Custom Resources](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)
- [Kubernetes: API Concepts and Resource Versions](https://kubernetes.io/docs/reference/using-api/api-concepts/#resource-versions)
- [K3s: Datastore Options](https://docs.k3s.io/datastore)
- [K3s: High Availability Embedded etcd](https://docs.k3s.io/datastore/ha-embedded)
- [Temporal: Workflow Execution](https://docs.temporal.io/workflow-execution)
- [Temporal: Activities](https://docs.temporal.io/activities)
- [Temporal Server Architecture](https://github.com/temporalio/temporal/blob/main/docs/architecture/README.md)
- [Amazon S3: Consistency Model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/)
- [Amazon S3: Conditional Writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- [Redis: Transactions](https://redis.io/docs/latest/develop/using-commands/transactions/)
- [Redis: Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Redis: Replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/)
- [Git glossary](https://git-scm.com/docs/gitglossary)
- [Git ignore documentation](https://git-scm.com/docs/gitignore)
- [Pro Git: About Version Control](https://git-scm.com/book/en/v2/Getting-Started-About-Version-Control)
- [Git reflog documentation](https://git-scm.com/docs/git-reflog)
- [Git garbage-collection documentation](https://git-scm.com/docs/git-gc)
- [GitHub: Setting Repository Visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
- [GitHub: Managing Actions Settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
