# OpenAB 獨立 Reviewer Session 與盲審可行性

> [!IMPORTANT]
> This historical report was migrated as non-normative research. Its selected
> review design describes the legacy system, not a decision accepted by this
> greenfield repository. See [legacy provenance](../legacy/provenance.md).

> 研究日期：2026-07-27<br>
> 部署基準：`openab-0.10.0-beta.2`<br>
> 基準 commit：[`967270087ab74b32bcba9f6bc89a402e7abc3aca`](https://github.com/openabdev/openab/tree/967270087ab74b32bcba9f6bc89a402e7abc3aca)<br>
> 核對之 upstream `main`：[`53061d696148106b2b7529f9d6c5dd802dff4545`](https://github.com/openabdev/openab/tree/53061d696148106b2b7529f9d6c5dd802dff4545)

## 結論

**部分原生可行，但嚴格盲審不能只靠 OpenAB 的 thread 設定完成。**

- OpenAB 原生支援「不同 Discord thread → 不同 ACP session」。
- 同一 thread 的 `per-lane` 只分開 sender buffer，最後仍序列進同一 session，不能用來隔離 reviewer。
- OpenAB 從 channel message 自動建立的是 Discord public thread；involvement gate 只決定某個 bot 是否處理訊息，不是 Discord 可見性 ACL。
- 因此，在同一共享父頻道建立兩個 public thread，只能做到 LLM context 的軟隔離，不能保證另一個 reviewer 的 bot identity 無法讀取報告。
- 本專案後續選擇非對抗性的 Review Decision Isolation：允許 reviewer 在平台層看見 sibling thread，但自動化路徑不得在各自報告 accepted 前，把另一 reviewer 的訊息、報告或 synthesis 投遞進其獨立 session。
- 嚴格的 reviewer-to-reviewer 隔離可用「每位 reviewer 一個私有父頻道 + 受限 Delivery Worker + 密封 Report Intake」實現；另一個選項是由自建 Orchestrator client 對每個 Broker 維護獨立 ACP WebSocket 連線。
- 不論使用 Discord 或 ACP，OpenAB 都不會替不同 Orchestrator thread 自動匯總狀態。Review Report 收集、延後揭露與 synthesis trigger 仍是上層 orchestration 責任。

本研究核對基準 tag 與上述 `main` commit；`docs/discord.md`、`docs/message-dispatch-modes.md`、`docs/output-directives.md`、`adapter.rs` 與 `discord.rs` 的本題相關行為沒有差異。

## 1. Thread 與 session 隔離原生可行

OpenAB 官方 Discord 文件說明，每個 thread 都有自己的 agent session。[Discord Thread Behavior](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/discord.md#L200-L208)

實作使用 `platform:<thread-or-channel-id>` 作為 session key，因此兩個 Discord thread 會取得兩個不同的 session-pool entry。[Adapter session key](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/crates/openab-core/src/adapter.rs#L577-L605)

不同 OpenAB agent 在 Helm 模式下也各有 Deployment、ConfigMap、Secret 與 PVC，不共用 agent state。[Multi-Agent Setup](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/multi-agent.md#L17-L22)

但 session 隔離不是 workspace 隔離。若同一 Broker 的數個 thread 指向同一 repository directory，git index、branch 與 working tree 仍可能互撞；Review Assignment 仍應使用 attempt-local read-only checkout 或 worktree。

## 2. `per-lane` 不是 reviewer session 隔離

`per-lane` 依 `(thread, sender)` 分開 buffer，確保不同 sender 各有一個 ACP turn；這些 turn 仍序列化進同一 thread session。[Message Dispatch Modes](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/message-dispatch-modes.md#L22-L48)

因此以下設計不成立：

```text
 one shared Discord thread
      |
      +-- reviewer-a lane --+
      +-- reviewer-b lane --+--> one shared ACP session

 per-lane ------------------X--> independent reviewer context
```

## 3. OpenAB 自動建立的是 public thread

OpenAB 在 bot 收到 parent-channel message 後，呼叫 Discord 的 `create_thread_from_message`，再把回覆送進該 thread。[OpenAB Discord `create_thread`](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/crates/openab-core/src/discord.rs#L161-L181)

Discord 官方規格指出，從既有訊息建立的 thread 是 public thread；public thread 對所有可查看父頻道的成員可見。Private thread 則是另一種 channel type，必須透過不同 API 建立並管理成員。[Discord Threads](https://docs.discord.com/developers/topics/threads#public-private-threads)

OpenAB 的 involvement gate 會阻止尚未 involved 的 bot 處理 thread 訊息，除非由 human 或 `trusted_bot_ids` 中的 bot 明確 mention；這是處理資源與 bot-to-bot admission control，不是 Discord 讀取權限。[OpenAB Involvement Gate](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/discord.md#L279-L323)

所以在共享父頻道內使用兩個 thread：

```text
 shared parent channel
    +-- public thread A --> reviewer-a session
    +-- public thread B --> reviewer-b session
```

可以避免 OpenAB 自動把 B 的訊息送進 A 的 LLM context，但只要 reviewer-a 的 Discord identity 有權查看 shared parent，它仍具有查看 public thread B 的平台權限。這不是嚴格盲審。

## 4. OpenAB 沒有原生跨 thread orchestration directive

目前正式 output directive 只有 `[[reply_to:<message-id>]]`，作用是把回覆連到同一 delivery context 中的某個訊息。沒有 `send_to_channel`、`create_private_thread`、`seal_report` 或 `fan_out_review` directive。[Output Directives](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/output-directives.md#L1-L40)

因此 Orchestrator agent 在主 thread 的一般文字輸出不能自行：

- 建立兩個 private reviewer thread；
- 邀請不同 reviewer bot；
- 把兩份 Work Offer 投遞到任意 sibling channel；
- 密封第一份報告直到第二份抵達；
- 把不同 Orchestrator ACP session 的 context 自動合併。

這些行為需要受限的外部 Delivery Worker／Report Intake，或一個對 OpenAB ACP endpoint 實作 client-side orchestration 的元件。

## 5. 已採用的第一版：共享父頻道下的決策隔離

Reviewer Broker 可共用一個 Discord 父頻道，但每份 Review Assignment 使用不同的 top-level trigger message、Discord thread 與 OpenAB session。Reviewer 只信任 Delivery Worker，不互相加入 `trusted_bot_ids`；共享父頻道不啟用 Ambient Mode。

此選擇曾記錄於 legacy ADR 0047；該 ADR 未遷移，也不在本 repo 自動生效。見
[legacy provenance](../legacy/provenance.md)。

```text
 shared review parent channel
       |
       +-- top-level Assignment A
       |       |
       |       +-- Thread / Session A --> frozen Report A --+
       |                                                    |
       +-- top-level Assignment B                           |
               |                                            |
               +-- Thread / Session B --> frozen Report B --+
                                                            |
                                              Synthesis Barrier
                                                            |
                                                   Orchestrator
```

建議 reviewer 設定形狀：

```toml
[discord]
allowed_channels = ["<SHARED_REVIEW_PARENT_CHANNEL>"]
allow_bot_messages = "mentions"
trusted_bot_ids = ["<DELIVERY_WORKER_BOT_ID>"]
allow_user_messages = "multibot-mentions"
```

這個選項只承諾自動化的 context isolation：

- Delivery Worker 為每位 reviewer 發送不同的 top-level 訊息，只 mention 該 Assignment 的 reviewer；
- Reviewer A 與 B 不互相信任，也不共用 review thread；
- 另一 reviewer 的可見訊息不會因可見性本身自動成為正式 review input；
- Review Report accepted 前，不把 sibling report 或 synthesis 投遞到 reviewer session；
- report freezing 表示 canonical content 與 digest 固定，不表示內容機密；
- 經授權的人類刻意 cross-mention 或 reviewer 主動搜尋 sibling content，不在第一版的非對抗性隔離保證內。

自動分派、canonical report intake、barrier 與 synthesis trigger 仍需要 GitHub Actions Transition Gate 和薄型 Delivery Worker；OpenAB 本身不提供這些 workflow semantics。

## 6. 嚴格隔離選項：私有父頻道

為每個 reviewer Broker Identity 預先建立一個 Discord 私有文字頻道，僅允許該 reviewer bot、Delivery Worker／Orchestrator bot 與 Operator 存取。每次 Review Assignment 由 Delivery Worker 在對應父頻道送一則獨立 top-level message；OpenAB 仍可使用既有行為，自動建立一個 public thread，但它位於受 ACL 保護的私有父頻道內。

```text
                     GitHub authority
               [Review Round / Assignments]
                           |
                           v
                    Delivery Worker
                  /                 \
                 v                   v
 private parent channel A     private parent channel B
 [reviewer-a only]            [reviewer-b only]
          |                            |
          v                            v
 OpenAB thread/session A      OpenAB thread/session B
          |                            |
          v                            v
 sealed Review Report A       sealed Review Report B
                  \             /
                   v           v
                    Report Intake
                   [content hidden
                    until both accepted]
                           |
                           v
                   Synthesis Trigger
                           |
                           v
                Orchestrator main session
```

Reviewer bot 的建議 Discord 設定形狀：

```toml
[discord]
allowed_channels = ["<REVIEWER_SPECIFIC_PRIVATE_PARENT_CHANNEL>"]
allow_bot_messages = "mentions"
trusted_bot_ids = ["<DELIVERY_WORKER_OR_ORCHESTRATOR_BOT_ID>"]
allow_user_messages = "multibot-mentions"
```

另需符合以下限制：

- reviewer bot 不取得其他 reviewer 父頻道的 `VIEW_CHANNEL` 權限；
- reviewer bot 不取得 server-wide `ADMINISTRATOR` 或廣泛的 thread 管理權限；
- 每個 Assignment 使用不同的 top-level trigger message，避免 Discord 的 one-thread-per-message 競爭；
- Delivery Worker 記錄 assignment、Discord thread ID 與 delivery attempt 的關聯；
- Report Intake 在兩份必要報告都 accepted 前，不把內容發到共享 Discord thread、GitHub Issue comment 或 reviewer 可讀的共用 artifact；
- GitHub State Snapshot 在密封期間只公開 receipt、digest 與狀態，不公開報告內容；
- Synthesis Trigger 必須明確把兩份 immutable report reference 送到 Orchestrator 的 synthesis session。

這個隔離的對象是其他 reviewer；Operator、Delivery Worker、Report Intake 與必要的系統管理者仍是受信任邊界，不是密碼學上的零知識設計。

## 7. 替代方案：Direct ACP star

OpenAB `0.10.0-beta.2` 提供標準 ACP WebSocket endpoint；正式 as-built ADR 將它定義為一個 client 對一個 agent 的 1:1 endpoint，而不是內建 multi-agent fan-out。[ACP WebSocket Base](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/acp-server-websocket-base.md#L15-L26)

官方也明確說明，多 agent 情境要由 client 連接 N 個獨立 OpenAB instances 並自行 relay；OpenAB ACP server 不負責 fan-out。[ACP client-side orchestration](https://github.com/openabdev/openab/blob/967270087ab74b32bcba9f6bc89a402e7abc3aca/docs/adr/acp-server-websocket-base.md#L255-L265)

```text
 Orchestrator ACP client
       +---- TLS/WS ----> reviewer-a /acp / session A
       +---- TLS/WS ----> reviewer-b /acp / session B
       |
       +---- sealed reports ----> Report Intake
```

此方案不把 Review Report 暴露在 Discord，但必須自行實作：

- N 條 authenticated ACP connection；
- session／request correlation；
- timeout、retry、deduplication 與 cancellation 補強；
- sealed report persistence；
- GitHub Work Item reconciliation；
- synthesis trigger。

它比私有 Discord 父頻道更乾淨，但第一版的新增基礎設施較多。

## 建議

依本專案已選擇的非對抗性 threat model，第一版採「共享父頻道 + 每份 Assignment 獨立 thread/session + GitHub Actions Transition Gate + Delivery Worker + frozen canonical reports + Synthesis Barrier」。它重用現有 Discord transport 與 session pool，不把平台可見性誤當成正式 review input。

私有父頻道保留給未來需要 reviewer-to-reviewer secrecy 的 threat model；Direct ACP 保留為後續 transport。在 canary 證明 delivery、session isolation、report freezing 與 synthesis barrier 之前，不應把 OpenAB 的 public thread 或 involvement gate 誤稱為嚴格盲審安全邊界。
