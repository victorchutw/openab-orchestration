# OpenAB seams for the first Operator journey

> [!IMPORTANT]
> Non-normative research input. This report describes upstream capabilities and
> gaps; it does not decide this repository's Run lifecycle.

- Researched: 2026-08-10
- OpenAB baseline: `main` at
  [`62453ac7272404a0920c822fb5f0b056b5a6a2cb`](https://github.com/openabdev/openab/tree/62453ac7272404a0920c822fb5f0b056b5a6a2cb)
- Sources: official OpenAB docs, source, tests, and the official ACP documentation

## Core findings

1. **OpenAB is a transport and session bridge, not a Run orchestrator.** Its
   explicit boundary excludes agent memory, multi-agent workflow, and governance;
   those belong above the broker. Therefore a Discord thread, ACP session, or
   coding-agent turn cannot be the authoritative Run.
   ([Thin Bridge](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/DESIGN.md#L11-L24),
   [What OpenAB Is Not](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/DESIGN.md#L121-L134))

2. **Starting and resuming a conversation is well supported, but it is not
   execution recovery.** On Discord, a human mention creates a thread and later
   thread messages reuse its session. A direct ACP client uses
   `initialize -> session/new -> session/prompt`, then may reconnect with
   `session/resume`. Resume does not replay history; the client retains its own
   display transcript, and a lost downstream context can silently become a fresh
   session with a visible expiry notice.
   ([messaging start and follow-up](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/messaging.md#L49-L104),
   [ACP methods](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/adr/acp-server-websocket-base.md#L89-L120),
   [resume boundary](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/adr/acp-server-websocket-base.md#L149-L167))

3. **OpenAB persists conversation locators, not business state.** The session pool
   stores thread-to-agent-session and workspace mappings, suspends idle sessions,
   and attempts downstream `session/load`. A transient load failure preserves the
   locator for retry; a permanent failure starts fresh. OpenAB has no objective,
   assignment, attempt, review, remediation, or Operator Decision record.
   ([pool state](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/crates/openab-core/src/acp/pool.rs#L17-L52),
   [load and fallback](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/crates/openab-core/src/acp/pool.rs#L554-L611),
   [pool limits](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/config-reference.md#L416-L431))

4. **Human-in-the-loop is conversational, not a typed wait or approval
   protocol.** Humans can reply in chat, and reactions can be mapped to text such
   as `approve`, `reject`, or `re-review`. Those inputs still become ordinary
   message dispatches. Meanwhile, downstream ACP tool permissions are
   auto-answered with the most permissive selectable option, and the network ACP
   endpoint does not relay `session/request_permission` to its client.
   ([reaction mappings](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/reactions.md#L1-L17),
   [permission selection](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/crates/openab-core/src/acp/connection.rs#L16-L75),
   [permission auto-reply](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/crates/openab-core/src/acp/connection.rs#L228-L280),
   [network ACP coverage](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/acp-official-methods.md#L53-L62))

5. **Cancellation has two different guarantees, neither sufficient for a durable
   terminal state.** Discord `/cancel` writes `session/cancel` directly to the
   downstream CLI; `/cancel-all` also drops current thread buffers. Network
   `/acp` cancellation stops the gateway waiter and fences late replies, but the
   backend work continues. A cancel signal or `stopReason: cancelled` therefore
   does not prove that tools and external effects have quiesced.
   ([Discord handlers](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/crates/openab-core/src/discord.rs#L1731-L1824),
   [network cancel limit](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/adr/acp-server-websocket-base.md#L122-L140),
   [network cancel cleanup](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/crates/openab-gateway/src/adapters/acp_server.rs#L2353-L2428))

6. **Timeout and retry behavior protects the transport, not execution semantics.**
   Core prompts have a default 30-minute ceiling; hung sessions are later
   force-evicted and their process groups terminated. The message dispatcher
   retries a dead consumer once, but in-flight or queued messages can still be
   lost, and buffered state has no WAL. OpenAB cannot determine whether a timed-out
   attempt already changed a worktree or produced an external side effect.
   ([timeout configuration](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/crates/openab-core/src/config.rs#L1716-L1739),
   [hung cleanup](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/crates/openab-core/src/acp/pool.rs#L859-L983),
   [residual message loss](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/adr/turn-boundary-batching.md#L249-L258),
   [non-durable buffers](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/adr/turn-boundary-batching.md#L873-L897))

7. **OpenAB provides useful views, not canonical evidence.** Status reactions show
   queued/thinking/tool/done/error; tool display shows running/completed/failed;
   Discord can export a transcript; structured logs include batching and latency
   fields. These do not form an append-only Run log, replayable upstream
   transcript, immutable artifact, or Evidence Bundle.
   ([reaction stages](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/config-reference.md#L566-L600),
   [tool display](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/tool-display.md#L21-L71),
   [thread export](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/slash-commands.md#L72-L99),
   [dispatch logs](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/adr/turn-boundary-batching.md#L825-L897))

8. **The upstream Review Contract is a valuable immutability pattern, not a
   runtime review engine.** It freezes the exact reviewed head together with a
   contract revision and exact contract text or SHA-256; later rounds review only
   unresolved findings, new changes, regressions, and frozen acceptance criteria.
   Its default sequence has three stages and can be extended by an owner, so it
   does not establish this project's at-most-one-remediation rule.
   ([contract and responsibilities](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/review-contract.md#L1-L47),
   [freeze and incremental review](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/review-contract.md#L49-L93),
   [stopping rule](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/review-contract.md#L123-L140))

## Ownership boundary

| Concern | OpenAB owns | Runtime Core / product contract owns |
|---|---|---|
| Start | Thread creation or ACP session/prompt delivery | Durable Run creation from the Operator objective |
| Continuity | Session locator, workspace, suspend/resume attempt | Run and Execution recovery independent of a session |
| Planning | Ordinary agent text | Required assignment fields, readiness, budget, and stopping conditions |
| Roles | Configured bot/agent process and isolated session | Agent Role Identity, Execution Profile, assignment and attempt identity |
| Human input | Chat turns and reaction-to-text UX | Typed wait, question/options, authority, decision version, idempotent transition |
| Permissions | Automatic downstream ACP permission response | Authority grants, least privilege, explicit approval and audit record |
| Cancel/timeout | Best-effort signal, waiter fencing, process cleanup | Cancel-requested state, effect reconciliation, confirmed terminal outcome |
| Retry | One consumer retry and downstream session-load retry | Attempt policy, deduplication, budget, reassignment, side-effect reconciliation |
| Observation | Messages, reactions, tool summaries, transcript export, logs | Canonical Run events, state projection, durable artifacts and Evidence Bundle |
| Review | PR Review Contract policy precedent | Immutable Review Target, independent reports, synthesis and finding lineage |
| Remediation | No workflow rule | Zero-or-one remediation transition and new immutable target |
| Final authority | No Run decision | Explicit Operator Decision and terminal Run semantics |

## Implications for the first Operator journey

- Create the Run before invoking OpenAB. Treat a thread/session as a replaceable
  Execution locator, never as the Run's identity or authority.
- Define an execution-ready assignment in Runtime Core. The Review Contract's
  Goal, Non-goals, risks, acceptance criteria, and exact-revision freeze are good
  inputs, but OpenAB does not enforce planning readiness.
- Model Operator questions, permissions, and decisions as durable typed waits.
  Chat messages and emoji reactions may drive those transitions only after
  correlation, authorization, and expected-state validation.
- Use `CancelRequested` as a convergence phase. Do not enter terminal `Cancelled`
  solely because a cancel notification was sent or a gateway waiter returned
  `cancelled`; reconcile the workspace and external effects first.
- Give every retry a new attributable attempt and reconcile prior effects. Session
  resume and transport retry are insufficient deduplication mechanisms.
- Freeze each Review Target by exact base, head, objective/review contract, and
  evidence digest. A remediation produces a new immutable target; it must not
  mutate the target already reviewed.
- Define the one-remediation cap and final Operator Decision in this product. They
  are not implied by OpenAB's transport or its three-stage PR review policy.
- Persist canonical Run events and Evidence Bundles outside OpenAB. Reactions,
  transcripts, and logs remain observability projections only.

## Uncertainties and documentation drift

- Native `/cancel` interruption quality depends on the downstream CLI. This
  research verified OpenAB's cancel write path, not every agent adapter's model
  and tool behavior. The slash-command documentation's blanket "immediate"
  wording is therefore too strong for a Runtime Core guarantee.
  ([documented claim](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/slash-commands.md#L53-L70),
  [write path](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/crates/openab-core/src/acp/pool.rs#L788-L810))
- `docs/slash-commands.md` omits `/cancel-all`, while current source registers and
  handles it. Source was treated as authoritative.
  ([documented table](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/slash-commands.md#L5-L17),
  [current registration](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/crates/openab-core/src/discord.rs#L1391-L1402))
- OpenAB's ACP coverage note is pinned to Schema v1.19.0. Official ACP has since
  stabilized `session/close`, but OpenAB does not advertise or implement it on
  the inspected commit.
  ([OpenAB version pin and coverage](https://github.com/openabdev/openab/blob/62453ac7272404a0920c822fb5f0b056b5a6a2cb/docs/acp-official-methods.md#L8-L43),
  [official ACP Session Close](https://agentclientprotocol.com/rfds/session-close))
