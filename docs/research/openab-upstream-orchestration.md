# OpenAB upstream 對 1:1:N 開發協作的能力與缺口

> [!IMPORTANT]
> This historical report was migrated as non-normative research. Its project
> goal and architecture references describe the legacy system, not decisions
> accepted by this greenfield repository. See
> [legacy provenance](../legacy/provenance.md).

> 研究日期：2026-07-24<br>
> 基準版本：`openab-0.10.0-beta.2`<br>
> 基準 commit：[`967270087ab74b32bcba9f6bc89a402e7abc3aca`](https://github.com/openabdev/openab/tree/967270087ab74b32bcba9f6bc89a402e7abc3aca)<br>
> 專案目標：Operator 在 Discord 指揮本機 Orchestrator；Orchestrator 指揮 Zeabur 上 N 個 Remote Brokers；GitHub 是 Development Work Item 的權威狀態。既有 broker 版本更新是次要能力，首次部署可人工介入。`openab-command-center` 不在本輪範圍。

## 結論摘要

1. **Discord-native 的 1:1:N 訊息拓撲可行。** `trusted_bot_ids`、明確 `@mention`、thread involvement gate、`multibot-mentions`、bot turn limits 與 `per-lane` dispatch 已提供足夠的路由原語，讓 Orchestrator 在自己的 Discord thread 逐一召喚 Remote Brokers。
2. **它只解決 transport，不解決 orchestration。** OpenAB 官方明確表示不管理 multi-agent workflow；Development Work Item 的建立、派工、認領、逾時、重派、完成判定與 GitHub reconciliation 都必須在 Orchestrator／GitHub workflow 層實作。
3. **GitHub SDLC 有可借用的官方模式，但沒有內建 work-item engine。** 可直接借用 `gh` 權限注入、Issue 讀寫與證據回報、PR Review Contract、commit status 去重與 stale timeout、CI → Discord 通知；OpenAB 本身沒有 GitHub Issue 狀態機。
4. **Discord delivery 不是 durable task delivery。** reaction 是 UI 狀態，batch queue 在記憶體內，consumer 只 retry 一次，pod／consumer failure 仍可能遺失已 enqueue 或 in-flight 的訊息；沒有通用 task ack、lease、heartbeat、WAL、reassignment 或 exactly-once guarantee。
5. **`0.10.0-beta.2` 沒有可用的 native GitHub Gateway adapter。** Custom Gateway ADR 中的 GitHub 是方向與範例；實際 adapter registry 沒有 GitHub module。
6. **ACP over WebSocket 是另一條可實驗的 Orchestrator → Broker transport。** 此版本的 unified image 已包含 ACP server，但官方 base 明定為 1:1、沒有 fan-out；Orchestrator 仍需自己維護 N 條 client connection，而且此版本有 long reply truncation 與 cancel 不會停止 backend 等限制。
7. **沒有第一方 Zeabur image update／rollback controller。** 官方有 Zeabur-compatible `configUrl` 與 restart 模式，但 image lifecycle 的完整 SOP 是 Kubernetes/Helm；`oabctl` 目前是 ECS provisioner。因此 broker 更新需要 Zeabur-specific executor、GitHub deployment workflow 或受限 SSH 等額外機制。

以上是能力邊界，不是架構決策。Discord、ACP WebSocket 或 GitHub-driven delivery 仍應分別做小型實驗再選擇。

## 研究方法與文件漂移

- 只使用 `openabdev/openab` tag 內的 docs、ADR、chart、source 與該版本的官方 GitHub release。
- 研究時 upstream `main` 與 tag 都指向同一 commit，因此本文沒有把尚未發布的 main 功能誤算進來。
- 同一 tag 內有 turn-limit 文件漂移：`multi-agent.md`／`messaging.md` 的部分段落仍寫 10 或 20；同 tag 的 config reference 與 Rust source 則是 soft limit 100、hard limit 1000。本文以 source 和 config reference 為準。[Config reference](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/config-reference.md#L70-L87) [Rust source](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/crates/openab-core/src/bot_turns.rs#L10-L18)

## 一、官方已證實的能力

### 1. OpenAB 的產品邊界

OpenAB 是 platform 與 coding CLI 之間的 transportation layer。官方明說它不管理 agent memory、不編排 multi-agent workflow、不治理 agent 行為；這些不是待補功能，而是刻意留給使用者的上層設計。[DESIGN — Thin Bridge](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/DESIGN.md#L11-L24)

同時，OpenAB 把 multi-bot 共存視為核心能力：每個 agent 有自己的 bot token、config 與 session pool，並提供 bot messages、trusted IDs、mentions 與 turn caps 等原語；sequential handoff、parallel collaboration、human-in-the-loop 或 agent discussion 由使用者決定。[DESIGN — Multi-Bot Ready](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/DESIGN.md#L26-L40)

在 Helm 模式，每個 `agents.<name>` 會產生獨立 Deployment、ConfigMap、Secret、PVC；不同 agent 不共享 state。[Multi-Agent Setup](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/multi-agent.md#L17-L22)

因此：

- OpenAB 可作本案的 Discord／ACP transport。
- OpenAB 不是 Development Work Item scheduler、GitHub reconciler 或 durable queue。

### 2. Discord-native Orchestrator → N Brokers

#### Admission 與 thread involvement

Discord adapter 預設忽略 bot message。可設定：

```toml
[discord]
allow_bot_messages = "mentions"
trusted_bot_ids = ["<ORCHESTRATOR_BOT_ID>"]
allow_user_messages = "multibot-mentions"
message_processing_mode = "per-lane"
max_bot_turns = 100
```

實際行為如下：

- `allow_bot_messages = "mentions"` 只處理明確 mention 自己的 bot message；`"all"` 才處理所有 involved bot messages。[Config reference](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/config-reference.md#L80-L85)
- `trusted_bot_ids` 非空時，只接受列出的 bot。更重要的是，trusted bot 的明確 mention 會越過 `allow_bot_messages` mode，等同 human mention，可把尚未 involved 的 broker 拉入 thread。[Discord guide](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/discord.md#L127-L137) [Implementation](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/crates/openab-core/src/discord.rs#L614-L700)
- 一般未受信任 bot 無法把另一個 bot 拉入陌生 thread；human mention 或 trusted-bot mention 才能通過 involvement gate。[Discord guide — Involvement Gate](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/discord.md#L301-L323)
- `multibot-mentions` 在單一 bot thread 允許自然 follow-up；一旦其他 bot 已發言，就要求 human 明確 mention 目標 bot，避免所有 bot 對每句話一起回應。[Discord guide](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/discord.md#L100-L125)

這支持以下流程：

```text
Operator @Orchestrator
  → Orchestrator 建立 Discord thread
  → Orchestrator 在 thread 內 @Broker-A
  → Broker-A 因 Orchestrator 在 trusted_bot_ids 而加入
  → Orchestrator 再 @Broker-B
  → Broker-A／B 回報到同一 thread
```

已知限制：一則 top-level channel message 同時 mention 多個 bot 時，只有第一個 bot 能成功建立 thread，第二個可能因 thread creation race 而丟失。符合本案的路徑是先由 Operator 喚起 Orchestrator，再由 Orchestrator 在既有 thread 逐一召喚 broker。[Discord guide — Known limitations](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/discord.md#L279-L305)

#### `per-lane` 的用途與界線

`per-lane` 以 `(thread, sender)` 分 buffer；不同 broker 的輸入各自形成 ACP turn，因此適合 Orchestrator 同時收到多個 Remote Broker 回報。它避免 `per-thread` 把多 sender 合成一個 turn 時的 silent-drop risk。[Message Dispatch Modes](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/message-dispatch-modes.md#L22-L48)

但不同 lane 最終仍序列化進同一個 thread session。`per-lane` 不是 N 個平行 Orchestrator session，也不是 job scheduler。[Message Dispatch Modes](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/message-dispatch-modes.md#L36-L48)

#### Turn cap

同 tag 的實際設定是：

- `max_bot_turns` soft limit 預設 100。
- human message 會 reset counter。
- compiled hard cap 是 1000。
- bot 的自有 reply 也計入總 bot message 數，而非每 bot 各算一份。[Config reference](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/config-reference.md#L80-L87) [BotTurnTracker source](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/crates/openab-core/src/bot_turns.rs#L1-L18)

這是 runaway-loop guard，不是 task attempt budget；不可拿它表示一個 Development Work Item 的最大重試次數。

### 3. Session、routing 與 workspace persistence

OpenAB 以 `platform:thread_id` 作 session key；同一 Discord thread 進同一 ACP session。每個 thread 有自己的 agent process／session，idle 後回收。[Session key source](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/crates/openab-core/src/adapter.rs#L577-L605) [Discord guide](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/discord.md#L200-L208)

Session pool 會把：

- `thread_key → downstream ACP sessionId` 寫入 `$HOME/.openab/thread_map.json`
- `thread_key → workspace path` 寫入 `$HOME/.openab/session_meta.json`

並以 temp file + rename 儲存。若 downstream agent 支援 `session/load`，restart／idle eviction 後可恢復；transient load failure 會保留 session ID，等下一則 message 再試，而不會把當前 message 送進 context-free session。[Session pool source](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/crates/openab-core/src/acp/pool.rs#L167-L243) [Resume path](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/crates/openab-core/src/acp/pool.rs#L335-L404)

`[[ws:@alias]]` 可在 session 第一則 message 選擇既存 workspace。路徑必須位於 bot HOME subtree、必須已存在；workspace 設定一次後 immutable，並可跨 suspend/resume 與 eviction rebuild 保留。[Workspaces](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/workspaces.md#L13-L56)

這些是 conversation continuity，不是 Development Work Item persistence。特別要注意：

- thread session 隔離不等於 git checkout 隔離。
- `[[ws]]` 不會自動為 Issue 建 branch、clone 或 worktree。
- 同一 broker 的多個 thread 若指向同一 repo directory，git index／branch／working tree 仍可能互撞。

Codex image 把 credentials、settings、session history、generated images 與 skills 放在 `/home/node/.codex/`；要跨 broker restart／image update 保存它們，Zeabur runtime 必須真的把相應 HOME 掛到 persistent volume。[Codex persisted paths](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/codex.md#L148-L156)

### 4. Steering、`AGENTS.md` 與 output directives

Workspace 能載入 `AGENTS.md`／agent-specific steering 與 skills，讓每個 broker 保持角色、禁止事項、branch convention、Issue/PR 更新格式等行為規則。[Workspaces](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/workspaces.md#L3-L11)

官方 steering guide 把 `AGENTS.md` 視為 hot memory，把 ADR、RFC、wiki 與歷史紀錄視為 cold storage；Codex 使用 hierarchical `AGENTS.md`。因此適合放「如何處理 Development Work Item」的穩定 protocol，不適合存放某個 work item 的當前 owner／attempt／status。[Steering Design Guide](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/steering-design-guide.md#L23-L52) [Agent mappings](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/steering-design-guide.md#L151-L168)

現行 output directive 的實際可用項目很窄：`[[reply_to:<message-id>]]` 可把 broker 回覆視覺上連到特定 Discord message；未知 directive 會被忽略。沒有 `task_id`、`accepted`、`lease`、`checkpoint`、`complete` 等 task protocol。[Output Directives](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/output-directives.md#L1-L40) [Multi-agent example](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/output-directives.md#L55-L67)

### 5. GitHub SDLC 可直接借用的官方模式

#### GitHub credentials 與 `gh`

官方 image 已包含 `gh`，官方文件建議以 fine-grained PAT、最小 repo 範圍與明確 Contents／PR／Issues 權限，使 agent 能 push branch、建立 PR、comment Issue。[GitHub Token Setup](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/github-token-setup.md#L1-L40)

Token 可透過 secret 注入成 `GH_TOKEN`／`GITHUB_TOKEN`；文件同時建議每個 agent 使用獨立 token／identity，避免所有 broker 共用一個無法歸責的 credential。[GitHub Token Setup](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/github-token-setup.md#L131-L160) [Security practices](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/github-token-setup.md#L192-L200)

#### Chat trigger → GitHub record → evidence

官方 remote-debugging refarch 已示範：

```text
Maintainer 在 chat 下令
  → agent 用 gh issue view 讀權威內容
  → 執行／驗證
  → gh issue comment 回寫結構化證據
```

這個模式可直接借用到本案的 Development Work Item，而不必把 Discord transcript 當權威紀錄。[Remote SSH Debugging](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/refarch/remote-ssh-debugging.md#L21-L83)

#### PR Review Contract

官方 Review Contract 把 Goal、Non-goals、Accepted Residual Risks、Acceptance Criteria、Follow-ups 放在 PR description，並要求 freeze record 記錄 reviewed head commit 與 contract revision／hash。這是很適合本案的可稽核 SDLC pattern。[Review Contract](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/review-contract.md#L8-L31) [Freeze semantics](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/review-contract.md#L37-L63)

#### GitHub status 作 durable dedup/reconciliation

PR review loop ADR 使用 commit status `pending/success/failure/error` 判斷是否觸發；`pending` 超過 30 分鐘視為 stale，重新觸發時 agent 再驗證 HEAD SHA。這是一個可以借用的 durable-state pattern：先讀 GitHub 狀態再重派，不能只因 Discord 沒回覆就盲目重送。[PR Review Loop](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/pr-review-loop.md#L55-L109)

#### CI → Discord

官方 refarch 使用 GitHub Actions 的 `if: always()` 將 CI 結果、PR URL、run URL 以 plain text 發到 Discord；plain text 讓 bot 可讀，Discord 是 notification surface，GitHub Actions／PR 仍保存權威結果。[CI Observability via Discord](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/refarch/ci-observability-discord.md#L90-L145)

這些都是可重用 pattern，不代表 OpenAB 已內建：

- Development Work Item schema
- broker owner／attempt／lease
- Issue label／Project field state machine
- branch／worktree allocation
- merge authority
- retry／reassignment policy

## 二、已證實的可靠性缺口

### 1. Discord reaction 不是 durable acknowledgement

👀／🤔／tool／done／error reaction 是訊息處理 UI；官方 config 只定義為 received、queued、thinking、done 等展示狀態，沒有 durable receipt、work-item attempt 或 replay 語意。[Reaction config](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/config-reference.md#L530-L563)

因此「看到 👀」最多代表 broker process 接到 message，不能證明：

- broker 已在 GitHub 原子地認領 work item；
- 對應 attempt 唯一；
- broker crash 後有人會重派；
- work 已完成或結果已持久化。

### 2. Dispatcher 是 in-memory buffer

batched dispatcher 在 consumer death 時只 transparent retry 一次；第二次失敗才向 Discord 顯示 error。[Turn-boundary ADR](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/turn-boundary-batching.md#L225-L245)

ADR 明確承認兩種 residual loss：

- dead consumer frame 中的 in-flight batch；
- receiver drop 時已 enqueue、尚未 drain 的 mpsc messages。

這些 message 的 `submit` 已回傳成功，之後卻可能消失；future supervisor 不在目前 scope。[Turn-boundary ADR — Residual losses](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/turn-boundary-batching.md#L253-L258) [Invariant summary](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/turn-boundary-batching.md#L803-L811)

### 3. Session watchdog 不是 distributed work watchdog

Session pool 能偵測 in-flight session 超過 `prompt_hard_timeout_secs + hung_grace_secs`，best-effort cancel，之後 SIGTERM／SIGKILL 並清除 resumable state。[Pool config](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/config-reference.md#L377-L386) [Hung eviction source](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/crates/openab-core/src/acp/pool.rs#L656-L770)

它能自救 hung CLI，但不會：

- 更新 GitHub work item 為 stale；
- 釋放 broker lease；
- 判斷 side effects 是否已部分完成；
- 產生新的 idempotency key；
- 把 work 重派給另一 broker。

### 4. 沒有通用 lease／heartbeat／exactly-once

在此 tag 的 OpenAB transport、session pool、output directives 與 GitHub docs 中，沒有通用 Development Work Item ack、lease、renewal、heartbeat、checkpoint、outbox、dead-letter queue 或 reassignment primitive。這是由產品的 thin-bridge 邊界與上述 residual-loss 設計共同證實，而不是單純「尚未找到設定」。

本案若重派工作，Orchestrator 必須先讀 GitHub 的 owner／attempt／branch／PR／HEAD SHA 與 side-effect evidence，再決定 retry；「Discord timeout → 原 prompt 原樣再送」會有重複 branch、comment、PR 或 deploy 的風險。

## 三、Gateway、ACP 與 GitHub adapter 的實際狀態

### 1. Custom Gateway 的 GitHub adapter 尚不可用

Custom Gateway ADR 把 GitHub／CI/CD 列為 webhook source，並示範 GitHub event normalize 成 GatewayEvent；但該 ADR 的 status 是 `Superseded`，且 reconnect + event replay／at-least-once delivery 仍列為 open design question。[Custom Gateway ADR](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/custom-gateway.md#L1-L20) [GitHub example](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/custom-gateway.md#L222-L290) [Open questions](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/custom-gateway.md#L308-L316)

`0.10.0-beta.2` 的實際 gateway adapter registry 只有 Telegram、LINE、Feishu、Google Chat、WeCom、Teams 與 ACP server，沒有 GitHub module。[Gateway adapter registry](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/crates/openab-gateway/src/adapters/mod.rs)

官方 GitHub webhook 文件也把目前方案稱為 v1 workaround：GitHub Actions → Discord webhook → OpenAB；native GitHub adapter 是目標方向，不是此 tag 已交付能力。[GitHub Webhook Integration](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/github-webhook-integration.md#L1-L21)

結論：本案不能把 Custom Gateway native GitHub adapter 當現成元件。

### 2. ACP WebSocket 是可實驗的替代 transport

`0.10.0-beta.2` 新增 ACP server over WebSocket；unified feature 包含 `acp`，官方 unified Dockerfile 以該 feature build，因此官方 agent images 已包含此 server code。[Release notes](https://github.com/openabdev/openab/releases/tag/openab-0.10.0-beta.2) [Cargo features](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/Cargo.toml#L26-L51) [Dockerfile](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/Dockerfile.unified#L18-L42)

它提供：

- `GET /acp`
- bearer key transport auth
- `initialize`
- `session/new`
- `session/prompt`
- partial `session/cancel`
- `session/resume`

非 loopback bind 沒有 `OPENAB_ACP_AUTH_KEY` 時會 fail closed；還需允許 synthetic sender `acp_client`。[ACP WS ADR](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/acp-server-websocket-base.md#L28-L100)

但官方同時明定：

- endpoint 是 1:1，不做 multi-agent fan-out；
- N-agent room 應由 client 對 N 個獨立 OpenAB instances 建連線並 relay；
- conversation transcript 不由 gateway 保存，client 要保存自己的 display transcript；
- cancel 只停止 gateway waiter，backend work 仍繼續；
- live test 已知 long replies 可能只收到第一 chunk 而截斷。[ACP WS ADR — Limits](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/acp-server-websocket-base.md#L122-L167) [1:1/no fan-out](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/acp-server-websocket-base.md#L181-L215) [Verified limits](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/acp-official-methods.md#L83-L100)

因此 ACP WS 是「Orchestrator 私下直連每個 broker」的候選 transport，不是現成 Orchestrator。仍需要 client/tool 管理：

- broker registry 與 endpoints
- N 條 connection/session
- request correlation
- timeout、retry、dedup
- GitHub reconciliation
- Zeabur ingress、TLS 與 secret rotation

## 四、版本更新與 Zeabur 支援

### 1. 可直接借用的 upstream update 規則

官方 image 格式為：

```text
ghcr.io/openabdev/openab:<version>-<agent>
```

Production 建議 exact version；沒有 `latest` agent tag。`beta-*`／`stable-*` 是 floating tags，不適合作可稽核 rollback point。[Image Tags](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/image-tags.md#L1-L25) [Which tag to use](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/image-tags.md#L47-L54)

官方 upgrade SOP 的安全結構可借用：

```text
resolve current/target
  → backup config/secrets/HOME state
  → upgrade
  → smoke test
  → failure rollback
```

但該完整流程是 Kubernetes/Helm 專用。[AI Install & Upgrade](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/ai-install-upgrade.md#L1-L8) [Backup/upgrade/smoke/rollback](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/ai-install-upgrade.md#L84-L200)

官方 canary guide 還要求：

- non-production bot identity
- isolated credential/workspace volumes
- previous exact image
- 不可同時用同一 bot token 跑兩個 instance
- 實測 multi-turn、tool、cancel、restart 後 `session/load`
- 一個 canary 成功後才 broad rollout，失敗回 exact baseline。[Canary prerequisites](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/canary-tests.md#L25-L38) [Runtime test](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/canary-tests.md#L413-L472) [Post-merge canary](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/canary-tests.md#L535-L561)

### 2. Zeabur 現成支援的界線

官方 proposed ADR 把 `configUrl` 描述為 Kubernetes、ECS、Zeabur、AgentCore 共通的 config path：Zeabur service 以 `openab run -c <url>` 啟動；更新 remote config 後 restart 即可載入。這處理的是 config delivery，不是 container image lifecycle。[ConfigUrl ADR](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/configurl-over-helm-rendering.md#L27-L42) [Zeabur usage](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/configurl-over-helm-rendering.md#L67-L95)

`oabctl` 官方定位是 Amazon ECS Fargate provisioner，Kubernetes 仍是 planned；文件沒有 Zeabur backend。[oabctl](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/oabctl.md#L1-L7)

在此 tag 的第一方文件／source 中，沒有：

- Zeabur service inventory driver
- image update API wrapper
- update health gate
- deployment rollback
- fleet-wide canary coordinator
- Zeabur credential scope model

所以本案的 broker version update 只能借用 exact-image、backup、canary、smoke、rollback 原則；實際 mutation mechanism 仍要由 Zeabur API／CLI、GitHub deployment workflow 或 VM 上受限 executor 提供。

## 五、對本案的推論（不是 upstream 承諾）

### 可保留的假說

- GitHub 作為 Development Work Item 唯一權威，與 upstream 的 Issue／PR／commit-status patterns 相容。
- Discord 作 Operator 的 command、conversation、notification surface，與 OpenAB 原生能力最貼近。
- Remote Brokers 保持獨立 identity、HOME、session pool、repo credentials 與 workspace，符合 upstream isolation model。
- Broker update 採 exact image、one-canary-first、restart/session/auth/Discord/GitHub smoke、明確 baseline rollback，可直接借用 upstream SOP 的安全結構。

### 必須修改或補足的假說

- 「Discord mention = 已派工」必須改成「Discord 是 delivery attempt；GitHub owner/attempt/state 才是 assignment」。
- 「broker 回覆 done = work 完成」必須改成「Orchestrator 以 GitHub PR/check/evidence 驗證後才 transition」。
- 「每 thread 一個 session = work isolation」不成立；還需要 per-work-item clone/worktree/branch policy。
- 「session watchdog 會自動恢復工作」不成立；還需要 GitHub-backed stale detection、lease/reassignment 與 side-effect-aware retry。
- 「Custom Gateway 可直接接 GitHub」不成立於 `0.10.0-beta.2`。
- 「OpenAB 能直接更新 Zeabur brokers」不成立；需要額外 lifecycle executor。

### 可淘汰的假說

- Discord transcript 是 durable work ledger。
- OpenAB bot-turn cap 是 task retry policy。
- 👀／done reaction 是 durable ack／completion。
- OpenAB session persistence 等於 GitHub work-item persistence。
- `configUrl` 能更新 container image。

## 六、仍未知，應以實驗回答

| 未知數 | 最小實驗 | 通過條件 |
|---|---|---|
| Discord trusted mention 能否穩定完成 1→N involvement | 1 Orchestrator + 2 canary brokers，在既有 thread 逐一 mention | 兩 broker 各只執行一次；未 trusted bot 無法加入 |
| Broker 回報如何再次喚起 Orchestrator | 比較 broker 明確 mention、Orchestrator `allow_bot_messages=all` + allowlist | 無廣播 storm；每份回報都進正確 Orchestrator session |
| `per-lane` 在多 broker burst 下的順序與延遲 | 兩 broker 同時回覆帶唯一 correlation ID | 兩份回報均保留、序列化行為可接受 |
| Discord message lost／duplicate 時的 recovery | 在 dispatch 前後 kill broker／Orchestrator | GitHub reconciliation 能辨識未認領、已認領、已完成，不盲目重做 |
| Codex `session/load` 在 Zeabur restart 後是否成立 | 同一 thread 做兩 turn、restart、再做第三 turn並查 logs | `$HOME/.openab` 與 `.codex/sessions` 持久；logs 證實 load 同一 session |
| 同一 broker 多 Issue 的 git isolation | 兩 thread 同時修改同 repo 不同 branch | checkout、index、branch、untracked files 不互撞 |
| GitHub assignment schema | 用一個 test Issue 模擬 claim、heartbeat、stale、retry、complete | 每個 transition 可稽核且有 idempotency/attempt |
| ACP WS 是否適合取代 bot-to-bot Discord | Orchestrator client 直連兩 canary `/acp` endpoints | TLS/auth、correlation、resume、long output、timeout 行為可接受 |
| Zeabur image update／rollback | 一個 non-critical broker 做 exact-image canary | old/new digest、persistent HOME、health、Discord/gh smoke、rollback 都有證據 |
| 權限與 merge authority | 用 test repo 驗證每 broker token | broker 只能操作授權 repo/branch；merge/deploy 權限符合治理決策 |

## 七、待決策的替代方案

### A. Discord-native star

```text
Operator → Discord → Orchestrator
                      ├─@mention→ Broker A
                      ├─@mention→ Broker B
                      └─@mention→ Broker N
GitHub ←──── authoritative reconciliation ────→ all agents
```

優點：最少新增 transport、可見性高、符合 OpenAB multi-bot 原語。

代價：best-effort delivery、Discord thread/involvement/mention 規則變成 orchestration dependency，需要 GitHub reconciler 補可靠性。

### B. Direct ACP star

```text
Operator → Discord → Orchestrator ACP client
                      ├─WS→ Broker A /acp
                      ├─WS→ Broker B /acp
                      └─WS→ Broker N /acp
GitHub ←──── authoritative reconciliation ────→ all agents
```

優點：broker 派工不必公開穿過 Discord bot conversation，可直接做 request correlation。

代價：需新建 N-connection client/tool、endpoint/TLS/auth/rotation；ACP base 仍不 durable、不 fan-out，且此版本有 verified limits。

### C. GitHub-driven brokers

```text
Operator → Discord → Orchestrator → GitHub Issue/PR state
                                       ├─poll/webhook→ Broker A
                                       ├─poll/webhook→ Broker B
                                       └─poll/webhook→ Broker N
```

優點：delivery 與 authority 聚合在 GitHub，較自然支援 restart reconciliation。

代價：OpenAB 沒有 native GitHub adapter，需要 GitHub Actions、poller 或自訂 gateway；要自行處理 claim race、rate limit 與 latency。

### D. Hybrid

Discord 用於低延遲喚醒與對話；GitHub polling/reconciliation 修復 missed delivery、stale work 與 restart。這最接近 upstream PR review loop 的做法，但仍需要明確定義哪一層可以改變 Development Work Item 狀態。

目前 upstream 證據不足以替本案在 A、B、C、D 中直接作決定；應先用一個 test repo、兩個 canary brokers 比較 Discord-native 與 ACP／GitHub recovery 行為。
