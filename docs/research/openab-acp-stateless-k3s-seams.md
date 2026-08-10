# OpenAB and ACP Seams for Stateless k3s Executions

> Research date: 2026-08-10<br>
> OpenAB baseline: [`openab-0.10.0-beta.3`](https://github.com/openabdev/openab/releases/tag/openab-0.10.0-beta.3), commit [`d64c678f0b5e4b26f52d5272b0c6743c4207a1b9`](https://github.com/openabdev/openab/tree/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9)<br>
> ACP baseline: stable wire protocol v1 at [`4d1345e3094abbc2fffba4fa0e2f3b4a55f0cc3b`](https://github.com/agentclientprotocol/agent-client-protocol/tree/4d1345e3094abbc2fffba4fa0e2f3b4a55f0cc3b); latest v1 schema release [`schema-v1.20.0`](https://github.com/agentclientprotocol/agent-client-protocol/releases/tag/schema-v1.20.0)

## Decision summary

OpenAB can be a replaceable k3s-hosted execution runtime behind the host Runtime Core, but it is not a complete Execution Adapter by itself. The viable seam is one authenticated ACP v1 WebSocket connection from the Runtime Core to each role-specific OpenAB endpoint. The Runtime Core must own execution identity, fan-out, state transitions, budgets, evidence, retry decisions, reviewer isolation, and reconciliation. OpenAB may retain provider authentication or session files as disposable cache, but a pod or its session must never be authoritative.

Three upstream behaviours prevent treating the current endpoint as a transparent, trustworthy execution boundary:

1. A matching `session/prompt` response is a trustworthy **ACP v1 turn boundary**, but its `stopReason` is not proof that the requested domain work succeeded or that evidence was durably captured.
2. OpenAB currently reports `stopReason: "cancelled"` to the upstream client without cancelling the downstream model or tools. It is therefore not proof that side effects stopped.
3. OpenAB accepts ACP `cwd` for wire conformance but deliberately does not apply it. Execution workspace selection must use OpenAB's contained workspace mechanism, and the actual mount, ownership, and provider sandbox must be verified separately.

The supported boundary is therefore:

```text
Host Linux
+---------------------------------------------------------------+
| Runtime Core (authoritative SQLite + evidence store)           |
|                                                               |
|  Run/Execution state -> ACP v1 client -> result validation     |
|         |                  |                |                  |
|         |                  |                +-> immutable      |
|         |                  |                    evidence       |
|         +-> cancellation fence / reconciliation               |
+----------------------------|----------------------------------+
                             | one authenticated WebSocket
                             | per Execution / Agent Role
                       k3s   v
              +--------------------------------+
              | role-specific OpenAB pod       |
              | /acp -> OpenAB core -> ACP CLI |
              | optional auth/session cache    |
              | execution-scoped workspace     |
              +--------------------------------+

Authority flows back only after a correlated ACP response and
Runtime Core validation. Pod state never becomes Run state.
```

## Findings at a glance

| Concern | Upstream seam | Required Runtime Core rule | Must be prototyped? |
|---|---|---|---|
| Transport | OpenAB `GET /acp` WebSocket, ACP v1, one client to one agent | One connection and endpoint profile per Execution role; Runtime Core performs all orchestration | Yes: host-to-k3s reachability and reconnect |
| Completion | Response to the original `session/prompt`, correlated by JSON-RPC id, with `stopReason` | Accept only after response, output contract, target digest, and evidence checks all pass | Yes: long output, disconnect, malformed and late replies |
| Cancellation | ACP `session/cancel` exists, but OpenAB only stops its upstream waiter | Fence the attempt as uncertain until downstream termination or isolation reset is observed | Yes: mandatory before automatic retry |
| Readiness | `/health` returns only `ok`; chart has no probes for normal agent Deployments | Layer process, WebSocket auth, ACP negotiation, session, provider, and workspace readiness | Yes |
| Filesystem | ACP defines `cwd`; OpenAB uses mounted pod storage and `[[ws:...]]` containment instead | Allocate an Execution-specific path under pod `HOME`; Coder writable, Reviewers read-only | Yes: each provider image and storage driver |
| Hooks | `pre_seed`, `pre_boot`, `pre_shutdown` at process lifecycle | Use only to hydrate or flush disposable cache; never as execution acknowledgement | Yes: graceful and forced restart cases |
| Authentication | OpenAB bearer on WebSocket plus pod-side provider credentials | Separate transport keys and role credentials; keep all secrets outside runtime records and Git | Yes: rotation and provider login expiry |
| Sessions | Upstream `session/resume`; downstream mapping and optional `session/load` under `HOME` | Treat continuity as an optimization; every attempt receives a complete Context Packet | Yes: restart with and without cache |
| Versions | OpenAB beta.3, ACP v1; ACP v2 is a changing draft | Pin image digest and adapter profile; reject unexpected negotiation or capability loss | Yes: conformance matrix per provider image |

## 1. Transport

OpenAB's intended network seam is `GET /acp`, enabled by the compiled `acp` feature and `OPENAB_ACP_ENABLED`. The unified `openab run` binary starts its embedded HTTP server for an ACP-only deployment, so Discord or another chat adapter is not required. The endpoint is JSON-RPC 2.0 over WebSocket and implements a one-client-to-one-agent chat surface; multi-agent fan-out is explicitly outside it. The ACP client must therefore maintain independent connections to independent OpenAB instances and combine their results itself. [OpenAB ACP base transport](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/adr/acp-server-websocket-base.md#L19-L38) [One-to-one limitation](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/adr/acp-server-websocket-base.md#L181-L187) [ACP-only startup source](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/src/main.rs#L188-L194)

For this MVP, each Orchestrator, Coder, and Reviewer slot needs a distinct Agent Role Identity and an endpoint profile that binds a particular OpenAB deployment, provider adapter, model policy, credentials reference, and workspace policy. A new Execution should open a new WebSocket and create a new ACP session unless an explicitly authorized continuation needs `session/resume`. Reusing one live session for sibling reviewers would defeat decision isolation even if the transport remains functional.

The official chart does not expose this endpoint for ordinary agent Deployments: the agent template has neither a declared container port nor probes, and the chart's `Service` is rendered only for its separate gateway mode. It does allow arbitrary environment entries and extra volumes, so an adapter-owned Service/probe overlay can supply the missing network surface without changing OpenAB itself. [Agent Deployment template](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/charts/openab/templates/deployment.yaml#L44-L138) [Gateway-only Service](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/charts/openab/templates/gateway.yaml#L262-L277)

The exact host-to-k3s route is not established by either project. It must be verified on the real single-host k3s installation. Prefer a non-public, role-specific endpoint; do not expose `/acp` through a public Ingress merely to make host access convenient. The deployment contract may use a dedicated ClusterIP plus a local routing adapter, or a loopback-bound forwarding process, but that choice belongs to the adapter/deployment ticket after the reachability prototype.

Discord should remain an optional Operator input or notification surface. Its delivery and reactions do not supply a correlated, durable execution response, while ACP provides a request id, turn response, errors, and version negotiation.

## 2. Trustworthy completion signalling

ACP v1 is precise about a prompt turn: progress arrives through `session/update`, while completion is the response to the original `session/prompt` request with a `StopReason`. Tool updates and accumulated text are not completion signals. [ACP v1 completion](https://github.com/agentclientprotocol/agent-client-protocol/blob/4d1345e3094abbc2fffba4fa0e2f3b4a55f0cc3b/docs/protocol/v1/prompt-turn.mdx#L215-L229) [ACP overview message flow](https://github.com/agentclientprotocol/agent-client-protocol/blob/4d1345e3094abbc2fffba4fa0e2f3b4a55f0cc3b/docs/protocol/v1/overview.mdx#L34-L40)

OpenAB follows that positive-path shape. It streams text notifications, then sends the final prompt response only after the reply route emits `Done` or closes; backend timeout becomes a JSON-RPC error rather than a successful stop reason. Its downstream client likewise treats only the matching id-bearing response as success and converts unexpected process EOF into an explicit error rather than presenting partial text as complete. [OpenAB upstream prompt response](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-gateway/src/adapters/acp_server.rs#L2353-L2428) [Downstream response correlation and EOF](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-core/src/adapter.rs#L862-L930)

The Execution Adapter may record an agent turn as received only when all of these are true:

1. the WebSocket remains valid through a JSON-RPC response whose id matches the outstanding `session/prompt`;
2. the response has a recognized ACP v1 result and a stop reason accepted by that Execution type;
3. the response output satisfies a versioned role-specific envelope rather than relying on free-form prose;
4. all declared evidence and artifacts exist, are readable by the Runtime Core, and match their recorded digests;
5. a Review Report names the exact immutable Review Target digest assigned to it; and
6. the Runtime Core commits the validated outcome and evidence references in its own transaction.

`end_turn` means the model stopped without requesting more tools; it does not mean tests passed, a patch is correct, or files were persisted. Other stop reasons such as `max_tokens`, `max_turn_requests`, `refusal`, and `cancelled` are defined protocol outcomes and must not be collapsed into success. [ACP v1 stop reasons](https://github.com/agentclientprotocol/agent-client-protocol/blob/4d1345e3094abbc2fffba4fa0e2f3b4a55f0cc3b/docs/protocol/v1/prompt-turn.mdx#L292-L310)

A JSON-RPC error, connection loss before the matching response, malformed or missing fields, evidence mismatch, or validation failure is not completion. The recovery policy must distinguish a definite failure before external effects from an uncertain outcome after effects may have begun.

OpenAB beta.3 changed ACP reply chunking so an ACP reply is delivered whole instead of being split after a route that accepts only its first delivered message. The source now sets the ACP message limit to `usize::MAX`, and the reply handler sends full text followed by `Done`. [Whole-reply limit](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-core/src/adapter.rs#L24-L35) [Final delivery](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-gateway/src/adapters/acp_server.rs#L2505-L2550) However, an older warning remains in the same release's methods document, while the current canary guide contains oversized and Unicode delivery checks. That documentation drift makes live verification against the exact deployed digest mandatory before relying on large reports. [Stale limitation text](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/acp-official-methods.md#L83-L97) [Current whole-delivery canary](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/canary-tests.md#L151-L167)

## 3. Cancellation and safe retry

ACP v1 says that after `session/cancel`, the Agent should stop model and tool operations, abort pending work, and only then respond to the original prompt with `stopReason: "cancelled"`. That response is meant to let the client confirm cancellation. [ACP v1 prompt cancellation](https://github.com/agentclientprotocol/agent-client-protocol/blob/4d1345e3094abbc2fffba4fa0e2f3b4a55f0cc3b/docs/protocol/v1/prompt-turn.mdx#L312-L345) Generic `$/cancel_request` also exists but is optional. [ACP v1 generic cancellation](https://github.com/agentclientprotocol/agent-client-protocol/blob/4d1345e3094abbc2fffba4fa0e2f3b4a55f0cc3b/docs/protocol/v1/cancellation.mdx#L10-L26)

OpenAB beta.3 does not meet that end-to-end semantic. Its `/acp` handler only signals the task waiting on the upstream reply; the waiter immediately returns `cancelled`. The official implementation ADR explicitly states that the downstream model/tool work continues and may queue beyond the upstream in-flight cap. [OpenAB cancel handler](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-gateway/src/adapters/acp_server.rs#L2131-L2157) [Waiter result](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-gateway/src/adapters/acp_server.rs#L2360-L2366) [Known backend-cancel gap](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/adr/acp-server-websocket-base.md#L122-L140)

Consequently, the adapter must interpret current OpenAB `cancelled` as **upstream observation stopped**, not **Execution terminated**. On cancellation it must:

- move the attempt to a cancelling or uncertain state;
- fence all later output by execution and turn identity;
- prevent that workspace and downstream session from being assigned to another attempt;
- obtain an independent termination observation, such as confirmed downstream process/pod termination followed by workspace reset; and
- permit the one automatic remediation retry only after the recovery policy proves isolation or idempotency.

OpenAB already fences late replies from a cancelled or timed-out turn by its originating event id, which prevents stale output from entering the next upstream prompt. That is useful transport hygiene, but it does not stop filesystem, Git, network, or provider side effects already in progress. [Late-reply fence](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-gateway/src/adapters/acp_server.rs#L2505-L2534)

## 4. Readiness

OpenAB's `/health` handler returns the literal string `ok`. It does not inspect whether `/acp` was mounted, a valid key is configured, the downstream ACP CLI can spawn, provider authentication is current, a session can be created, the model is reachable, or the requested workspace is usable. [Health handler](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-gateway/src/lib.rs#L1110-L1112) The ordinary agent Deployment template also has no startup, readiness, or liveness probe. [Agent container template](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/charts/openab/templates/deployment.yaml#L44-L138)

The deployment and adapter contract needs layered observations:

1. **Process:** the intended pod generation is running and its container is ready according to an adapter-owned startup/readiness probe.
2. **Transport:** a bearer-authenticated WebSocket upgrade to the role endpoint succeeds.
3. **Protocol:** `initialize` negotiates exactly the supported ACP version and expected capabilities.
4. **Session:** `session/new` succeeds for an Execution-scoped workspace.
5. **Provider:** a bounded, non-mutating smoke prompt proves the downstream CLI can authenticate and produce a correlated response.
6. **Execution:** the immutable Context Packet, target, writable or read-only workspace, and evidence output path are present with the expected access modes.

Only the Runtime Core decides whether an Agent Role is eligible for assignment. Kubernetes readiness and `/health` are observations, never authority. Each layer needs a freshness timestamp; a successful observation from an old pod generation must not be reused after replacement.

## 5. Filesystem and workspace access

ACP v1 normally makes `cwd` the absolute primary working directory, the base for relative paths, and part of the filesystem root boundary. [ACP v1 working directory](https://github.com/agentclientprotocol/agent-client-protocol/blob/4d1345e3094abbc2fffba4fa0e2f3b4a55f0cc3b/docs/protocol/v1/session-setup.mdx#L358-L367) Its `fs/read_text_file` and `fs/write_text_file` methods are different: they let an Agent reach the Client editor's filesystem, and the Agent must not call them unless the Client advertised those capabilities. [ACP v1 client filesystem](https://github.com/agentclientprotocol/agent-client-protocol/blob/4d1345e3094abbc2fffba4fa0e2f3b4a55f0cc3b/docs/protocol/v1/file-system.mdx#L6-L29)

Neither path behaves that way through current OpenAB:

- OpenAB's downstream ACP client advertises empty `clientCapabilities`, so it offers no Client-side filesystem callbacks. The downstream coding CLI instead accesses files mounted directly in its pod. [Downstream initialize request](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-core/src/acp/connection.rs#L549-L576)
- OpenAB's upstream `/acp` validates `cwd` and `mcpServers` for wire shape but deliberately does not propagate them to the downstream working directory. Its supported selection seam is a `[[ws:...]]` control directive resolved through containment under the bot's `HOME`. [OpenAB cwd limitation](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/adr/acp-server-websocket-base.md#L200-L212)
- A workspace must exist, be a directory, canonicalize under bot `HOME`, and is immutable for a session. [OpenAB workspace boundary](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/workspaces.md#L40-L56)

The Runtime Core should create a unique workspace for every Execution attempt, make it visible at a stable path beneath the relevant pod's `HOME`, and select it in the first prompt with an adapter-generated `[[ws:@execution-alias]]` directive. The Coding Agent receives a writable worktree. Each Reviewer receives a distinct read-only snapshot or checkout of the same Review Target digest and no sibling report. A shared mutable checkout is not an acceptable optimization.

The chart's default security context runs as UID/GID 1000, drops capabilities, and uses a read-only root filesystem. It mounts a writable `HOME` PVC only when persistence is enabled and always mounts a writable `/tmp` empty directory; custom workspaces require explicit extra volumes and mounts. [Chart security defaults](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/charts/openab/values.yaml#L31-L44) [Agent volumes](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/charts/openab/templates/deployment.yaml#L113-L168)

A `read_file denied` log is therefore not diagnostic by itself. The prototype must classify at least these independent causes: path outside the OpenAB workspace boundary, missing or read-only mount, UID/GID/mode mismatch, downstream provider sandbox or permission policy, and an attempted ACP Client-filesystem call that OpenAB did not advertise. OpenAB automatically selects the most permissive option from downstream `session/request_permission`, but that cannot override kernel permissions, container mounts, or provider sandboxing. [OpenAB permission auto-response](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-core/src/acp/connection.rs#L16-L75) [Permission reader path](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-core/src/acp/connection.rs#L228-L280)

## 6. Lifecycle hooks

OpenAB's official hook names are `pre_seed`, `pre_boot`, and `pre_shutdown`; there is no generic `pre_hook` or `post_hook` interface. `pre_seed` restores archives first, `pre_boot` runs after seeding and before agent-pool construction, and `pre_shutdown` runs after the pool stops. Script hooks accept exactly one absolute script path, inline script, or checksum-pinned URL, with explicit timeout and failure policy. They run with a sanitized environment as the container UID and do not receive OpenAB chat secrets. [Hook order and names](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/hooks.md#L1-L17) [Script sources and controls](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/hooks.md#L116-L207)

These are pod-process lifecycle seams, not per-Execution hooks. OpenAB runs boot hooks before secret resolution and pool creation, then runs `pre_shutdown` only after shutting down the pool. [Startup ordering](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/src/main.rs#L446-L491) [Shutdown ordering](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/src/main.rs#L1770-L1805)

Use them only for idempotent hydration or best-effort flushing of disposable provider authentication and session cache. Do not use a hook to mark an Execution complete, export its sole evidence copy, or make a pod authoritative. `pre_shutdown` cannot be guaranteed after process crash, node loss, or forced termination; Kubernetes ultimately force-kills containers after their termination grace period, and an immediate deletion need not wait for confirmation. [Kubernetes Pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)

If strict ephemeral pods are desired, `pre_boot` may materialize cache from a private store and `pre_shutdown` may refresh it. The prototype must still prove provider login behaviour with an empty cache and after an interrupted shutdown. A cache restore failure should reduce readiness, not corrupt Runtime Core state.

## 7. Authentication and secret boundaries

There are two separate authentication layers:

1. **Runtime Core to OpenAB transport.** `OPENAB_ACP_AUTH_KEY` protects `/acp`; non-browser clients should send it in `Authorization: Bearer`. OpenAB refuses to mount an unauthenticated endpoint on a non-loopback bind, uses a timing-safe comparison, and removed query-string tokens. [OpenAB transport auth design](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/adr/acp-server-websocket-base.md#L40-L79) The synthetic sender `acp_client` must separately pass OpenAB's gateway identity gate through `GATEWAY_ALLOWED_USERS=acp_client` or an intentionally broad allow policy. [OpenAB identity gate](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/adr/acp-server-websocket-base.md#L80-L85)
2. **OpenAB/downstream Agent to provider.** ACP's `authMethods` and `authenticate` describe Agent login advertised during initialization. OpenAB's upstream endpoint advertises `authMethods: []`; it relies on credentials already available to the role pod and downstream CLI. [ACP v1 authentication](https://github.com/agentclientprotocol/agent-client-protocol/blob/4d1345e3094abbc2fffba4fa0e2f3b4a55f0cc3b/docs/protocol/v1/authentication.mdx#L35-L111) [OpenAB capabilities and empty auth methods](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-gateway/src/adapters/acp_server.rs#L1925-L1984)

Use distinct transport bearer references and provider credential references per Agent Role or Execution Profile. Supply them through private k3s Secrets or private mounted credential stores, never through the public checkout, Context Packet, evidence bundle, or Runtime Core database. The Runtime Core should know a stable credential reference and rotation generation, not its value. Because the endpoint is plain WebSocket rather than native TLS, keep it on a trusted local/cluster boundary or add a local TLS termination layer if traffic crosses that boundary.

`OPENAB_ACP_TRACE` is off by default and records prompt, reply, and negotiated capability content when enabled. It must remain disabled for normal operation and must not become an evidence mechanism. [ACP trace warning](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-gateway/src/adapters/acp_server.rs#L281-L305)

## 8. Session persistence and statelessness

OpenAB's upstream server mints `sess_<uuid>` and derives an `acp_<uuid>` channel. On WebSocket disconnect its per-connection session map disappears; a client can reconnect with `session/resume`, which restores context without replaying a transcript. Whether the downstream context was actually restored is not observable at the gateway: if it expired, OpenAB may start fresh and prefix a notice. [Session mapping and resume semantics](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/adr/acp-server-websocket-base.md#L142-L171) [Disconnect behaviour](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/adr/acp-server-websocket-base.md#L213-L215)

Inside OpenAB, the downstream pool persists thread-to-session and workspace mappings at `$HOME/.openab/thread_map.json` and `$HOME/.openab/session_meta.json`. After a restart it attempts downstream `session/load` only if that provider's ACP implementation advertises support; otherwise it creates a new session. The default pool TTL is four hours. [Persistence paths](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-core/src/acp/pool.rs#L274-L301) [Conditional load or new session](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-core/src/acp/pool.rs#L552-L595) [Default TTL](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/crates/openab-core/src/config.rs#L1912-L1919)

This can improve latency and preserve hidden model context, but it cannot satisfy the architecture's recovery invariant. Every attempt must receive a complete immutable Context Packet, target digest, role policy, and evidence destination from the Runtime Core. Losing a pod, its upstream session id, or its downstream transcript must permit a new attempt with a new Execution id; it must never erase or retroactively change a committed outcome. Reviewer Executions should always use fresh independent sessions. Orchestrator and Coding continuity may be enabled as a profile optimization, but their explicit plans, patches, checks, and decisions still belong in host evidence.

"Stateless OpenAB" should therefore mean **no authoritative domain state in OpenAB**, not necessarily zero bytes of persistent cache. A role-private `HOME` cache can be retained if access is isolated, encrypted and backed up as a credential asset, replaceable without losing Run correctness, and never shared between reviewers. If a provider requires a persistent OAuth/session directory, a strictly empty pod filesystem may be impractical; that is a provider-specific prototype result, not a reason to move Runtime Core authority into the PVC.

## 9. Version and capability constraints

The first candidate baseline should be an exact `openab-0.10.0-beta.3-<agent>` image digest, not a floating `beta-<agent>` tag. OpenAB documents exact version-plus-agent tags for pinned production or CI use. [OpenAB image tags](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/image-tags.md#L1-L25) The release is still a beta, so the digest and observed capability matrix are part of the Execution Profile, not an implicit deployment detail.

OpenAB beta.3 vendors ACP schema v1.19.0 and negotiates integer wire `protocolVersion: 1`. The latest stable v1 schema release is v1.20.0; its release notes add only an unstable tool-call name, so no relevant stable chat field is known to differ, but the used subset still needs round-trip tests. [OpenAB vendored schema pin](https://github.com/openabdev/openab/blob/d64c678f0b5e4b26f52d5272b0c6743c4207a1b9/docs/adr/acp-server-websocket-base.md#L287-L304) [ACP schema v1.20.0 release](https://github.com/agentclientprotocol/agent-client-protocol/releases/tag/schema-v1.20.0)

Do not target ACP v2 for this MVP. It is a changing draft, and it deliberately changes the prompt response from a turn-completion signal into message acknowledgement while Agent idle state carries lifecycle meaning. Completion logic written for v1 would be wrong on v2. The adapter should negotiate and require v1 until a separately designed v2 completion model exists. [ACP v2 lifecycle change](https://github.com/agentclientprotocol/agent-client-protocol/blob/4d1345e3094abbc2fffba4fa0e2f3b4a55f0cc3b/docs/announcements/acp-v2-draft.mdx#L23-L29) [ACP v2 draft warning](https://github.com/agentclientprotocol/agent-client-protocol/blob/4d1345e3094abbc2fffba4fa0e2f3b4a55f0cc3b/docs/announcements/acp-v2-draft.mdx#L57-L63)

Each provider-specific image must be qualified independently for CLI version, model selection, startup time, provider authentication, permission mode, session-load support, filesystem policy, output size, and cancellation behaviour. An OpenAB tag alone does not pin those downstream behaviours.

The inspected OpenAB `main` commit [`62453ac7272404a0920c822fb5f0b056b5a6a2cb`](https://github.com/openabdev/openab/tree/62453ac7272404a0920c822fb5f0b056b5a6a2cb) did not change the files relevant to these seams after beta.3. This report therefore uses the release rather than unreleased `main` as its implementation baseline.

## 10. Prototype gates

The following facts must be tested against isolated, non-production profiles before implementation can treat the adapter as qualified. None requires resuming the retired live canary.

### Gate A: transport and positive completion

- From the actual host process boundary, connect to each role endpoint with the correct bearer and prove wrong or missing credentials fail closed.
- Negotiate ACP v1, create a new session, submit a prompt, correlate interleaved updates and the final response by id, and reject a mismatched or duplicate id.
- Produce an oversized Unicode response larger than the former split limit; verify byte-for-byte reconstruction and a final response after the last chunk.
- Interrupt the WebSocket before the final response and prove partial text never commits an Execution outcome.

### Gate B: cancellation and reconciliation

- Start an instrumented downstream action with an observable, isolated side effect; send `session/cancel`; confirm the current OpenAB false-positive behaviour and measure how long backend work continues.
- Exercise the chosen termination primitive, observe that the child process/pod and side effects stopped, fence late output, reset the workspace, and only then authorize retry.
- Kill or partition the transport at each stage and prove the recovery state distinguishes definite failure from uncertainty.

### Gate C: readiness and restart

- Exercise cold start, invalid provider auth, expired auth, downstream CLI crash, missing workspace, wrong ownership, read-only Coder mount, and unreachable provider. Prove `/health` alone does not admit work and the layered gate identifies the failed layer.
- Replace a pod during an Execution and between Executions. Prove old observations, session ids, and late responses cannot complete a new attempt.
- Repeat with an empty `HOME` and with a role-private restored cache. Correctness must be identical; only latency or login requirements may differ.

### Gate D: filesystem and role isolation

- Coding Agent: read and modify only its writable Execution worktree and write declared evidence.
- Each Reviewer: read the identical Review Target digest through a separate read-only mount, fail to modify it, and have no path to the other Reviewer's report or session cache.
- For every selected provider image, capture whether a denial came from OpenAB workspace containment, Linux permissions, the container mount, or provider tooling. Do not qualify an image while `read_file denied` remains ambiguous.

### Gate E: hooks and versions

- Demonstrate idempotent `pre_boot` with empty and populated cache and bounded failure behaviour.
- Exercise graceful shutdown, hook timeout, forced kill, and restart. Prove a missed or repeated `pre_shutdown` cannot lose an authoritative artifact or duplicate an Execution transition.
- Run the same conformance suite against every pinned image digest and downstream CLI version. Reject capability regression, unexpected protocol version, or unqualified floating tags.

## 11. Consequences for the existing Wayfinder map

This research resolves the upstream capability question without creating a new decision ticket. Its follow-up decisions are already partitioned by the map:

- the adapter surface, Service, layered health observations, authentication references, hooks, and version profile belong to **Choose the first adapter and deployment contracts**;
- cancellation fencing, uncertainty, safe retry, and reconciliation belong to **Define runtime recovery and external-effect semantics**;
- workspace permissions, role-private cache, and reviewer isolation belong to **Define Agent Role identity, isolation, and execution policy**; and
- the fake/local experience and state flow belong to **Prototype the complete coding-review-remediation loop** before any live provider qualification.

The remaining fog is provider- and environment-specific measurement: exact cold-start and authentication latency, the best host-to-ClusterIP route on this k3s installation, storage-driver ownership behaviour, and whether each chosen CLI can operate with ephemeral credentials. Those results should be recorded in the relevant Execution Profile rather than generalized from OpenAB or ACP documentation.
