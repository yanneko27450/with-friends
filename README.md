# Friends with Claude

A Claude Code plugin: a side pane that shows which friends are online and what **kind** of work
they are doing with Claude (for example "Fixing bugs · a website"). It never shares your conversation.

[繁體中文說明在下面](#繁體中文)

## Install in 3 steps

Use a **local** Claude Code conversation (the Code tab of the Claude desktop app with a folder on your
own computer, or `claude` in a terminal). Cloud sessions can't reach the relay, and the pane only
shows on your own computer.

1. Add the marketplace and install:
   ```
   claude plugin marketplace add https://friends-status-relay.friends-status-relay.workers.dev/marketplace.json
   claude plugin install with-friends@with-friends
   ```
2. Open a **new** conversation.
3. When the Friends with Claude box appears after installing, paste the `/friends join …` line a friend
   sent you into that box (not into the conversation), or start your own group with
   `/friends create <your name>`. If no box appears, open a new conversation and send only that line.
   `/friends help` lists every command.

Third-party marketplaces do not update automatically by default. You can turn on auto-update in
`/plugin` → Marketplaces, or update manually with `/friends update`.

## What is shared, and what never is

| Your friends in the group see | Only the relay sees | Never sent to the relay or your friends |
|---|---|---|
| The display name you choose, and your group's name | Your member key, only as a login (the relay stores just a hash of it) | What you type to Claude, Claude's answers, file contents |
| Working / idle / offline, and how long ago you were last seen | The invite code, once, when you join | File names, folder paths, URLs, the list of folders you hid |
| Two codes from a fixed list: what kind of work, and on what kind of thing (`mod/hooks/taxonomy.ts`), and how long ago they changed | A random ID for each conversation | Any other free text (your display name and group name are the only free text sent): the relay rejects fields it doesn't know |
| The plugin's version number, and the avatar code you picked from a fixed list of 16 | Your IP address, to limit too many requests (kept in memory, not stored) | |
| Whether you created the group | | |

- How the two codes are made: your prompt is first masked on your computer (keys, passwords, emails,
  links, paths, file names, IP addresses, long numbers and code are replaced with placeholders; only the
  first 4000 characters are looked at, and at most 1500 are kept). The Claude you are already using then
  picks the two codes from the masked text. Only the codes go to the relay.
- `/friends pause` stops sharing activity (friends only see whether you are online).
  `/friends hide [folder]` (the current folder if you leave it out): in that folder friends only see
  that you are working, not what kind of work.
- A group holds up to 10 people. Activity codes are deleted from the relay after 24 hours.
- Friends' names are only drawn in the pane. Command replies never contain them, so they never enter
  your conversation with Claude.

## New since 0.4.0

- **Avatars**: pick one of 16 fixed avatars with `/friends avatar <code>` or the "Change avatar"
  button in the pane.
- **"What's new" box in the pane**: a small box in the pane lists the version history, so you can
  see what changed in each version.
- **`/friends status`**: a one-line summary for phones and terminals (how many friends are online,
  working or idle, and the most common kind of work). It never lists names.
- **Relay URLs limited to https**: relay addresses must use https, except for local testing.
- **Signed relay responses**: relay responses are signed, so the plugin can check that they really
  came from the relay.

## Run your own relay

By default everyone uses the official relay. To keep your group's data in your own Cloudflare
account (free plan), see [relay/DEPLOY.md](relay/DEPLOY.md).

## Security

- What the plugin protects against, and where in the code: [SECURITY.md](SECURITY.md).
- Found a problem? Please open an issue in this repository. **Do not post invite codes, keys, or
  conversation content.**
- The install package can be rebuilt from this repository with the same sha256. The `verify-build`
  workflow compares it on every push; for the version that is live it must print `MATCH`.

Read the code first if you like: the plugin is the few files in `mod/hooks/`.

## Repository layout

| Path | What |
|---|---|
| `mod/` | The plugin (`hooks/register.tsx` is the main file) and its tests |
| `relay/core.mjs` | Relay logic shared by both servers |
| `relay/server.mjs` | Relay for Node (local testing) |
| `relay/worker/` | Relay for Cloudflare Workers, the install-package builder, and the guide page |
| `relay/DEPLOY.md` | Run your own relay on Cloudflare's free plan |

Tests: `node relay/test.mjs`, `node relay/expiry.test.mjs`, and `claude plugin test mod`.

## Credits

Ideas borrowed from [SaharCarmel/claude-who](https://github.com/SaharCarmel/claude-who) and
[chrisluo5311/squad-chat](https://github.com/chrisluo5311/squad-chat) (both MIT).
This is a third-party plugin, not an Anthropic product. MIT licensed, see [LICENSE](LICENSE).

---

## 繁體中文

Claude Code 外掛：在側邊 pane 看到朋友在不在線、正在用 Claude 做**哪一類**事（例如「修錯誤 · 網站」），不會分享對話內容。

## 三步安裝

要用「本機」對話（Claude 桌面版 Code 分頁選你自己電腦上的資料夾，或在終端機開 `claude`）。雲端對話連不到中繼，pane 也只會出現在你自己的電腦上。

1. 加入市集並安裝：
   ```
   claude plugin marketplace add https://friends-status-relay.friends-status-relay.workers.dev/marketplace.json
   claude plugin install with-friends@with-friends
   ```
2. 開一個**新的**對話。
3. 裝好後跳出的框出現時，把朋友傳給你的 `/friends join …` 那一行貼進框裡（不是貼進對話），或用 `/friends create 你的名字` 自己開一個群組。如果沒有跳出框，就開一個新對話，只傳那一行。`/friends help` 會列出所有指令。

第三方市集預設不會自動更新，可在 `/plugin` → Marketplaces 打開 auto-update，或用 `/friends update` 手動更新。

## 會分享什麼、永遠不會分享什麼

| 群組裡的朋友看得到 | 只有中繼看得到 | 不會送到中繼、朋友也看不到 |
|---|---|---|
| 你自己取的名字、群組名 | 你的成員金鑰，只當登入用（中繼只存它的雜湊） | 你打給 Claude 的內容、Claude 的回答、檔案內容 |
| 工作中／閒置／離線，和多久前在線 | 邀請碼，只在加入時送一次 | 檔名、資料夾路徑、網址、你藏起來的資料夾清單 |
| 固定清單裡的兩個代碼：在做哪一類事、在做哪一類東西（`mod/hooks/taxonomy.ts`），和多久前換的 | 每個對話各一個隨機代號 | 名字和群組名以外的任何自由文字（名字和群組名是唯一會送出的自由文字）：中繼收到不認得的欄位一律拒絕 |
| 外掛的版本號，和你從 16 個固定頭像裡挑的那個代碼 | 你的 IP 位址，用來擋太頻繁的請求（只在記憶體、不存） | |
| 你是不是群組建立者 | | |

- 兩個代碼怎麼來的：你的訊息先在你的電腦上遮掉敏感字（金鑰、密碼、email、網址、路徑、檔名、IP 位址、長數字和程式碼換成泛稱；只看前 4000 字、最多留 1500 字），再交給你正在用的 Claude 從清單挑兩個代碼。送到中繼的只有代碼。
- `/friends pause` 暫停分享動態（朋友只看得到你在不在線）；`/friends hide [資料夾]`（不寫就是目前的資料夾）：在那個資料夾裡，朋友只看得到你在工作，看不到哪一類事。
- 一個群組最多 10 人；動態代碼在中繼上 24 小時後刪除。
- 朋友的名字只畫在 pane 上，指令的回覆裡不會有，所以不會進到你和 Claude 的對話。

## 0.4.0 之後的新東西

- **頭像**：從 16 個固定頭像裡挑一個，用 `/friends avatar 代碼` 或 pane 上的「換頭像」鈕。
- **面板的「What's new」小框**：pane 裡的小框會列出版本紀錄，看看每一版改了什麼。
- **`/friends status`**：給手機和終端機用的一句摘要（幾位在線、工作中／閒置幾位、最多人在做哪一類事），不會列出任何名字。
- **中繼網址限制 https**：中繼網址只能用 https，本機測試除外。
- **中繼回應簽章**：中繼的回應都有簽章，外掛可以確認回應真的是中繼送的。

## 自己架中繼

預設大家都用官方中繼。想把群組資料放在你自己的 Cloudflare 帳號（免費方案）：看 [relay/DEPLOY.md](relay/DEPLOY.md)（英文）。

## 資安

- 外掛防了什麼、在程式哪裡：[SECURITY.md](SECURITY.md)（英文）。
- 發現問題請在這個 repo 開 issue，**不要貼邀請碼、金鑰或對話內容**。
- 安裝包可以用這個 repo 重新打出來、sha256 一樣。每次 push 都有 `verify-build` 自動比對；線上那一版要印 `MATCH`。

想先看程式碼再決定也可以：外掛本體就是 `mod/hooks/` 裡那幾個檔案。

## 存放區結構

| 路徑 | 內容 |
|---|---|
| `mod/` | 外掛本體（`hooks/register.tsx` 是主要檔案）和它的測試 |
| `relay/core.mjs` | 兩個中繼伺服器共用的中繼邏輯 |
| `relay/server.mjs` | Node 版中繼（本機測試用） |
| `relay/worker/` | Cloudflare Workers 版中繼、安裝包打包工具和說明頁 |
| `relay/DEPLOY.md` | 用 Cloudflare 免費方案自己架中繼 |

測試：`node relay/test.mjs`、`node relay/expiry.test.mjs` 和 `claude plugin test mod`。

## 借鑑出處

想法借鑑自 [SaharCarmel/claude-who](https://github.com/SaharCarmel/claude-who) 和 [chrisluo5311/squad-chat](https://github.com/chrisluo5311/squad-chat)（皆 MIT）。這是第三方外掛，不是 Anthropic 的產品。授權 MIT，見 [LICENSE](LICENSE)。
