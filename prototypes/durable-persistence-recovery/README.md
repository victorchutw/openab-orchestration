# 耐久化持久儲存與復原原型

> 可拋棄原型（THROWAWAY PROTOTYPE）— 這是用來支撐設計決策的證據，不是正式版 Runtime Core 程式碼。

這個原型要回答：哪一種具體的 SQLite transaction（交易）、prepared
commit（已準備但尚未生效的提交）、artifact store（產出物儲存區）、restore
（復原）、migration（結構遷移）與 package layout（套件配置），可以滿足
OpenAB MVP 的復原語意，同時避免讓復原副本變成第二個權威來源？

原型提供兩種互補的操作方式：

- `prototype.py` 會對暫存 SQLite 資料庫與檔案系統做真實實驗：在提交邊界強制
  結束處理程序、移除暫存的主要儲存區、中斷「複製後啟用」的結構遷移，並執行
  孤兒資料清理。
- `prototype.html` 是單一檔案的互動式決策模型。直接開啟後，可依引導流程逐步
  查看每個耐久化步驟完成後，哪一份狀態才具有權威。

在 repository 根目錄執行真實實驗：

```bash
python3 prototypes/durable-persistence-recovery/prototype.py
```

程式只使用 Python 標準函式庫。所有可變資料都建立在暫存目錄，執行結束時會
自動移除。

## 技術名詞

- **Authoritative SQLite（權威 SQLite）**：唯一能決定 Runtime Core 當前狀態的
  SQLite 資料庫。復原資料只能驗證或重建它，不能自行成為另一個決策來源。
- **Commit capsule（提交封包）**：不可變的完整提交描述，內含 Commit ID、前一個
  提交、修訂版、authority epoch、schema 版本、configuration digest（設定摘要）、
  請求與回條、狀態異動、產出物參照及 Effect Intent。封包先寫入復原邊界，之後才
  把完全相同的內容套用到權威 SQLite。
- **Recovery boundary（復原邊界）**：主要儲存區遺失後仍可使用的獨立儲存故障域；
  它保存復原世代、提交封包與內容定址產出物。
- **Content-addressed store（內容定址儲存區）**：以內容的 SHA-256 digest（摘要值）
  當作檔案位置；相同內容共用同一個身分，內容一旦改變便會得到不同位置。
- **Authority epoch（權威世代）**：每次 restore 或 migration 啟用後遞增的權威版本；
  舊世代的能力只能回報遲到證據，不能繼續推進狀態。
- **`fsync`**：要求作業系統把已寫入的檔案資料推送到持久儲存裝置，避免只停留在
  記憶體快取。原型仍不宣稱所有硬體都具有相同的斷電保證；正式資格驗證必須涵蓋
  指定的檔案系統與儲存裝置。
- **2PC（two-phase commit，兩階段提交）**：先讓所有參與者進入已準備狀態，再共同
  提交的協定。此原型比較的是由應用程式協調兩個可寫 SQLite 的做法。

## 比較的配置

### A. 主要資料庫提交後，再完整鏡像 SQLite

主要資料庫先提交，接著才複製到復原邊界，最後才回覆呼叫端已接受。若處理程序在兩者
之間崩潰，主要資料庫會看得到轉換，復原副本卻沒有。若要隱藏這個轉換，主要資料庫
又必須加上「已準備／可見」協定；而且每次確認都要等待一份隨資料量成長的完整備份。

### B. 由應用程式協調兩個可寫 SQLite 的 2PC

同一個關聯式異動會分別在主要與復原 SQLite 進入準備、提交階段。這條路可以做到
正確，但兩邊的 schema（資料庫結構）、migration、constraint（限制條件）與修復工具
都會變成提交協定的一部分。復原端不再只是單純的耐久化邊界，而會成為第二套可變的
狀態機。

### C. 復原優先的不可變提交封包，加上一個權威 SQLite

產出物位元組會先寫入主要與復原內容儲存區；完整且不可變的 commit capsule 接著先在
復原邊界持久化，最後才由一個 SQLite transaction 套用到權威主要資料庫。只有提交封包
時，狀態仍是 prepared（已準備、尚未生效）；重新啟動時，若前一個提交、payload
（負載內容）、授權與產出物都驗證通過，系統可以完成同一個 Commit ID。若 SQLite
出現沒有對應有效封包的資料列，則視為 integrity failure（完整性失敗），不能算成已接受
狀態。

這是目前的暫定建議。互動流程與 fault injection（故障注入）輸出，是讓維護者在接受
前找出反例的依據。

## 暫定具體設計

- 使用一個權威 SQLite 資料庫，開啟 WAL（write-ahead log，預寫式日誌）模式，並設為
  `synchronous=FULL`。
- 每次狀態轉換都表示成 canonical（格式唯一化）、不可變的 commit capsule，包含
  Commit ID、前一個提交、修訂版、authority epoch、schema 版本、configuration
  digest、請求身分與摘要、耐久化回條、domain mutation（領域異動）、產出物參照與
  Effect Intent（外部效果意圖）。
- `durability` 內部強制每個 Installation 同時只有一個 writer（寫入者），而且最多只能有
  一個「下一修訂版」處於 prepared 狀態。Linux 參考配置使用 advisory writer lock
  （協同式寫入鎖）；啟動時必須先處理唯一的 prepared capsule，才接受下一個候選提交。
- 內容定址檔案放在 `objects/sha256/<摘要前兩碼>/<其餘摘要>`。主要與復原儲存區都要
  先完成 `fsync`、原子改名及上層目錄 `fsync`，才可以寫入提交封包。
- 先持久化復原提交封包，再於一個主要 SQLite transaction 套用完全相同的 payload。
  只有兩邊都驗證完成，才能回覆已接受或派送新的 External Effect（外部效果）。
- Restore（復原）使用已驗證的 SQLite recovery generation（復原世代）加上依序排列的
  capsule tail（尚未併入世代的後續提交封包）。候選資料庫會在新 authority epoch 及
  Installation-wide recovery gate（整個安裝實例的復原閘門）下原子啟用。
- Migration（結構遷移）先透過一般耐久化提交協定進入離線升級閘門，再複製資料庫、
  於候選檔交易式地修改 schema、檢查不變量、建立復原世代，最後原子啟用。不可直接
  修改使用中的資料庫，也不可只在候選資料庫內寫入升級閘門。
- 垃圾收集只刪除超過 grace period（保留緩衝期），而且經完整參照掃描確認未被主要
  資料庫、prepared capsule 或任何保留復原世代參照的 staging（暫存）或 orphan
  （孤兒）位元組。

主要與復原根目錄是兩個分別設定、由 Operator 控制的私人儲存綁定。Preflight
（執行前檢查）會拒絕兩者解析到相同根目錄；參考配置還必須證明它們位於不同儲存
故障域，不能只根據路徑字串不同就推定互相獨立。

一般 restart（重新啟動）只讀取主要 head，驗證它的精確提交封包，以及最多一個下一筆
prepared capsule；不需重播全部歷史。週期性、已驗證的 SQLite recovery generation
會截斷 capsule tail。只有至少兩個完整可復原的保留世代都涵蓋某個封包時，該封包才
可以 compact（壓縮移除）。升級時，舊 schema 的前一個世代會保留，直到新 schema 下
有兩個世代通過驗證。

## 建議的套件 seam

外部 `RuntimeCore` Interface（介面）維持不變。內部配置如下：

- `coremodel` 擁有純函式的狀態轉換、驗證與 projection（投影）邏輯。
- `runtimecore` 依序處理交換、呼叫 `coremodel`，再送出一個領域層級的
  `CommitCandidate`。
- `durability` 是 deep module（深模組）：用小型介面包住大量行為。它的介面只負責
  開啟已驗證狀態、提交候選、復原指定世代，以及回報復原閘門；內部隱藏 SQLite
  transaction、commit capsule、內容提升、復原世代、migration、`fsync` 順序及孤兒
  資料清理。
- SQLite schema 程式碼、檔案系統操作、capsule encoding（封包編碼）與 fault hook
  （故障注入掛鉤）都是 `durability` 私有的內部 seam（可替換接縫），不是呼叫端可見
  的套件。

關鍵介面結果只有 `Committed`（已提交）、`Duplicate`（重複請求）、`Conflict`
（衝突）、`ReadOnlyDegraded`（降級為唯讀）或 `RecoveryRequired`（需要復原）。呼叫端
不能直接控制 prepare 階段、SQL、產出物改名或 authority epoch 啟用。進入與解除閘門
本身也必須是已提交的狀態轉換，不能靠直接修改 metadata（中介資料）來清除 restore
或 upgrade gate。
