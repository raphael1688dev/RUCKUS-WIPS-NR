# RUCKUS WIPS - 程式碼邏輯分析與改善建議

這份文件記錄了針對 RUCKUS WIPS (Node-RED + MQTT bridge) 專案中核心 JavaScript 程式碼 (`fn_ruckus` 節點) 與附屬 Python 探測工具的邏輯分析，以及為了增進長期穩定性所提出的改善建議。

## 1. 程式碼邏輯分析

專案的核心在於如何穩定地與未完全遵守標準 HTTP RFC 的 RUCKUS Unleashed 控制器進行通訊，並將資料轉換給 Home Assistant。

### 1.1 Node-RED 核心驅動 (Ruckus AJAX driver)

*   **自定義的底層 HTTP / TLS 客戶端 (`rawReq`)**
    為了避開 Node.js 原生 HTTP 解析器對不規範回應 (例如不尋常的 Chunked Encoding) 的嚴格阻擋，實作中直接開啟了 `tls.connect` 的 Raw Socket。發送 `HTTP/1.0` 與 `Connection: close` 來強制伺服器回傳後斷開，並自定義了 `dechunkBuf` 函式來手工解析封包內容與維護 Cookie。這是非常具備韌性且防彈的做法。
*   **認證與狀態保存 (Session & CSRF)**
    *   `discoverLoginUrl()` 自動處理登入時的 302 重定向。
    *   `login()` 利用 `HEAD` 請求完成驗證，並擷取 `http_x_csrf_token`。
    *   若過程中遇到 Session 失效 (被踢出)，錯誤攔截邏輯會觸發自動重新登入並重試請求，具備自我修復機制。
*   **資料擷取與分頁處理 (Polling)**
    *   **Active Rogues**：對 `recognized='!true'` 發送請求，但由於 Ruckus 系統特性，回傳清單可能混雜「已封鎖」的 AP，因此需要在記憶體中做二次篩選。
    *   **Blocked Rogues**：透過 `getRoguesPiecewise` 進行分頁請求 (Pagination)。利用 `start`、`pid` 以及 `done='true'` 參數，不斷迴圈直到抓取完整的清單。
*   **資料標準化與新威脅比對 (Diffing)**
    將不規則的 XML 轉換成標準化 JSON 格式 (`normalize()`)。對於同一個 Rogue AP 若被多個內部 AP 偵測到，`pickStrongestDetection()` 會自動篩選出 **RSSI 訊號最強** 的紀錄。
    程式碼將本次清單與前一次暫存在 `seenBssids` 記憶體的清單進行差異比對；只有出現全新 BSSID 時，才會觸發 `new_rogue` 的 MQTT 事件，防止事件風暴發生。
*   **MQTT 指令與 Home Assistant 發現機制 (Command & Discovery)**
    *   初次啟動時自動廣播 MQTT Discovery 設定封包，包含 4 個實體 (`sensor` 和 `event`)。
    *   監聽 MQTT 收到的 `mark_malicious` / `unmark_malicious` 指令。當收到封鎖指令且驗證 BSSID 格式無誤後，發出 XML 寫入命令，並主動呼叫再次 Poll，讓狀態即時同步。

### 1.2 Python 探測工具 (`probe.py` / `probe_unblock.py`)

*   **`probe.py`**：透過 `aioruckus` 套件進行逆向工程測試。若存在 Active Rogue，會嘗試發送三種不同的 XML Payload，隨後讀取封鎖清單以驗證哪種 Payload 真正生效。
*   **`probe_unblock.py`**：嘗試四種不同的解除封鎖指令。並內建**安全復原機制**：無論測試成功與否，最終都會將測試對象重新封鎖，確保網路安全不出現空窗期。

---

## 2. 潛在風險與改善建議

儘管目前邏輯相當完備，但長期執行仍有幾個可優化之處：

> [!IMPORTANT]
> ### 2.1 控制器 API 的併發與競態條件 (Race Condition) - [已修正]
> **問題**：原本的 polling 邏輯使用 `Promise.all` 併發發出 `getActiveRogues()` 與 `getBlockedRogues()`。這不僅會對控制器的單一 Admin Session 造成壓力，更會產生**競態條件 (Race Condition)**。因為兩個請求共用 Node-RED `context` 內的同一份 cookie jar 與 CSRF token，若其中一個遇到 302 (Session 過期) 並觸發重新登入，另一個請求若同時也在使用舊 Token 或觸發登入，將導致互相覆寫 Session 狀態，產生驗證失效的連鎖反應。
> **解決方案**：已將程式碼修改為**循序執行 (Sequential execution)**，先 `await getActiveRogues()` 完成後，再 `await getBlockedRogues()`，徹底消除併發帶來的狀態衝突問題。

> [!TIP]
> ### 2.2 MQTT Payload 大小控制
> **問題**：完整的 `rogues` 陣列直接放進 `ruckus_wips/state/...` 的 Payload 裡。當惡意基地台多達數百台時，Payload 將十分巨大，會無謂消耗 Home Assistant 的 JSON 解析效能。
> **改善**：可以加入數量限制，例如只保留 `last_seen` 最近的 100 筆詳細資料放進 attributes，超出的僅計算總數 (`count`)。

---

## 3. 架構溯源與移植分析 (Architecture Porting Analysis)

本 Node-RED 專案 (`flows/ruckus_wips.json`) 在設計上，是一個非常精確且高完成度的 **跨語言架構移植 (Architecture Port)**。其參考來源為 `RUCKUS-HACS` (Home Assistant Custom Component, Python 實作)。

比對兩邊的程式碼，可以發現 Node-RED 腳本完美繼承並重現了原本 Python 整合的核心邏輯，這不僅保證了邏輯的正確性，也展現了極佳的系統解耦 (Decoupling) 思維。

### 3.1 核心邏輯的完美對應
*   **資料正規化 (Normalization)**：Node-RED 內的 `pickStrongestDetection()` 與 `normalize(rec)`，邏輯完全對應 Python `coordinator.py` 中的 `_pick_strongest_detection()` 與 `Rogue.from_api()`，確保了轉換給 HA 的實體狀態與舊版 Python 整合毫無差異。
*   **API 循序請求 (Sequential Polling)**：剛才修正的 `Promise.all` 併發問題，其實在原先的 Python 整合中就已防範。Python 版的 `_async_update_data()` 嚴格採用 `await api.get_active_rogues()` 接著 `await api.get_blocked_rogues()` 的循序設計。將 JS 版修正回循序執行，正是向原設計看齊。
*   **狀態差異與事件觸發 (State Diffing & Event Firing)**：Node-RED 利用 `context.seenBssids` 來暫存歷史資料，取代了 Python 類別實例中的 `self._seen_bssids`。兩者在第一次啟動時皆會執行「靜默寫入 (Seed silently)」策略，防止重新啟動時發生事件風暴。當發現全新的 BSSID 時，Node-RED 透過 MQTT 發布 `ruckus_wips/event/new_rogue` 訊息，精準對應 Python 的 `hass.bus.async_fire(BUS_EVENT_NEW_ROGUE)`。
*   **控制指令 (Commands)**：`services.py` 裡的 XML Payload (如 `check-ability='10'` 與 `xcmd='blockrogue'`) 以及錯誤驗證邏輯 (`xmsg.type != "0"`)，在 Node-RED 中也以 JavaScript 原汁原味地重現。

### 3.2 系統解耦的價值
透過這次將原本掛載在 Home Assistant 核心 (HACS) 內的 Python 輪詢邏輯，遷移至 Node-RED 獨立執行並轉換為 **MQTT Discovery**，達成了極佳的架構進化：
1.  **隔離底層髒活 (Isolating Dirty Work)**：處理 Ruckus 設備底層不規範 HTTP 協定的問題（手寫 TLS Socket 與 Chunk 解析器），被隔離在 Node-RED 容器內，不再影響 HA Core，提升了主系統穩定性。
2.  **狀態無縫銜接**：HA 端只需專心處理標準的 MQTT 格式，感測器與事件全自動建立，無需再負擔任何網頁抓取與連線維護的成本。

### 3.3 Node-RED Add-on 環境與 Native Modules 挑戰
在將 Node-RED `fn_ruckus` 重構為正式 npm 模組 (`node-red-contrib-ruckus-unleashed`) 的過程中，為了徹底解決 Ruckus 畸形封包問題，我們決定引入底層綁定 C++ 函式庫的 `node-libcurl` 作為 HTTP 引擎。

然而，經過對 Home Assistant Node-RED Add-on 的官方 Dockerfile 原始碼分析後發現：維護團隊為了保持映像檔最小化，會在使用 `apk add --virtual .build-dependencies` 安裝完 `g++`、`make`、`python3` 並編譯內建模組後，立刻執行 `apk del --purge` 將整包編譯工具鏈徹底刪除。

這項極致精簡的設計，對於發布 Node-RED 第三方套件產生了深遠影響：
1. **依賴原生模組的致命傷**：在預設的 HA Node-RED 環境中，執行 `npm install` 安裝任何需重新編譯 C++ 擴充 (Native Modules) 的套件（如 `node-libcurl`）都會直接報錯失敗。
2. **官方解法的體驗代價**：雖然 HA 官方提供 `system_packages` 設定，允許使用者手動補回這些 Alpine 編譯工具，但此舉會拖長每次容器重啟的時間，並且嚴重破壞了「開箱即用 (Plug and Play)」的絲滑體驗。

**最終決策與權衡 (Plan A)**：在權衡之後，**使用者最終明確決定採用方案 A：使用 `node-libcurl` 以獲得極致穩定的 HTTP 解析度，並接受 Home Assistant 的 `system_packages` 繞路解法**。我們在 `README.md` 中詳細指引了使用者手動設定 `g++`、`make`、`python3` 的步驟，為部署障礙提供了明確且可行的基礎設施級解決方案。

---

## 4. 技術債修補與優化成果記錄 (Technical Debt Resolution)

本專案在重構為正式套件後，針對各層面的技術債進行了全面的分析與清剿，修補成果記錄如下：

### 4.1 多節點 Session 並發登入鎖 (Mutex Lock)
*   **技術債背景**：多個 WIPS 節點或 Command 節點共享同一個 Session 實例，當 Session 剛好過期 (302) 時，多個節點同時觸發 `login()` 會導致 `csrfToken` 與 Cookies 被互相覆寫，產生競態條件（Race Condition）與連鎖認證失敗。
*   **解決方案**：在 `RuckusSession` 中實現了 **登入 Mutex 鎖**。將進行中的登入動作快取至 `this.loginPromise`。當並發的登入請求抵達時，直接 `await` 已在執行中的 `loginPromise` 共享認證結果，確保只會對控制器發起一次 HEAD 登入請求，安全消除了 Race Condition。

### 4.2 seenBssids 快取 Context 持久化
*   **技術債背景**：`seenBssids` 歷史 AP 列表原本存在節點閉包記憶體中，每次 Deploy 或是 Node-RED 重啟時會重置。重啟後的第一次輪詢會因為快取為空而將新 AP 視為已知並靜默寫入，導致「新基地台警報事件 (new_rogue)」遺失。
*   **解決方案**：將 seenBssids 轉存至 Node-RED 推薦的 `node.context().get('seenBssids')` / `set` 結構中。在支援檔案持久化的 Node-RED 環境中，這能跨越重啟與 Deploy 完整還原狀態，徹底封堵了威脅警報遺失的隱患。

### 4.3 首創「失靈安全 (Fail-safe)」MQTT 可用性狀態廣播
*   **技術債背景**：如果 Ruckus 控制器斷電或斷線，感測器雖然在 UI 上會報錯，但因為沒有對外廣播 MQTT Offline 訊息，導致 Home Assistant 端卡在舊有的「安全狀態」，造成重大安全監控盲區。
*   **解決方案**：將 `ruckus-wips-sensor` 節點升級為 **3 個輸出端點 (3 Outputs)**。
    *   **Output 1**：發送 Rogue AP 清單 (State JSON)。
    *   **Output 2**：發送新威脅事件 (Event JSON)。
    *   **Output 3**：**新增可用性輸出**。輪詢成功時發送 `online`，輪詢失敗進入 `catch` 時發送 `offline`。
    使用者只需將 Output 3 的線路連接至 `mqtt out` 節點，發布到 `status` 主題，即可使 Home Assistant 完全掌握 WIPS 本身的健康與連線狀態。

### 4.4 暴露 UI 自訂 Timeout 與 Pagination 參數
*   **技術債背景**：原本超時時間 (15秒)、最大 Rogues 限制 (300) 以及分頁大小 (100) 皆為硬編碼寫死，不便於在大型高延遲網路或巨型部署環境下進行調校。
*   **解決方案**：
    *   在 `ruckus-config` 中暴露 `Timeout` 設定。
    *   在 `ruckus-wips-sensor` 中暴露 `Max Rogues` 與 `Page Size` 設定。
    底層 API 全面重構為參數化接收，提供彈性的運維操作。

### 4.5 創新「Require Override」極速無硬體 Mock 單元測試
*   **技術債背景**：專案高度綁定實體 Ruckus 設備與二進制 C++ 庫 `node-libcurl`。在本地開發環境（如 macOS）或沒有二進制 binary 的乾淨 CI 容器中，`npm install` 和單元測試會直接崩潰。
*   **解決方案**：在 `test/wips-api.test.js` 中實現了 **Require 攔截覆寫技術**。在加載 Session 前，動態攔截並 Mock 了 `node-libcurl` 模組，從而以純 JS 極速運行 5 大測試（解析遞迴 XML、最強 RSSI 正規化、並發 Mutex 登入鎖、RuckusClient SDK 封裝），實現了 **「零依賴、免編譯」的高效單元測試與 CI/CD 驗證流程**。

