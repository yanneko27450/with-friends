# Friends with Claude

A Claude Code plugin: a side pane that shows which friends are online and what **kind** of work
they are doing with Claude (for example "fixing bugs · website"). It never shares your conversation.

[繁體中文說明在下面](#繁體中文)

## How it works

- Your prompt is turned into two codes from a fixed list (`mod/hooks/taxonomy.ts`) on your side.
  Only the codes, your chosen display name and online state go to a small relay server.
- The relay keeps a group of up to 10 people. Activity codes are deleted after 24 hours.
- Full details, with pointers to the code: **[SECURITY.md](SECURITY.md)**.

## Install

Use a **local** Claude Code conversation (the Code tab of the Claude desktop app with a folder on your
own computer, or `claude` in a terminal). Cloud sessions can't reach the relay, and the pane only
shows on your own computer.

```
claude plugin marketplace add https://friends-status-relay.friends-status-relay.workers.dev/marketplace.json
claude plugin install with-friends@with-friends
```

Then open a new conversation and paste the `/friends join …` line a friend sent you, or start your own
group with `/friends create <your name>`. `/friends help` lists everything.

Read the code first if you like: the plugin is the few files in `mod/hooks/`.
The install package can be rebuilt from this repository with the same sha256 (see SECURITY.md).

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

Claude Code 外掛：在側邊 pane 看到朋友在不在線、正在用 Claude 做**哪一類**事（例如「修 bug · 網站」），不會分享對話內容。

- 你送出的訊息會在你這邊被分成固定清單裡的兩個代碼（`mod/hooks/taxonomy.ts`），只有代碼、你取的名字和在線狀態會送到中繼。
- 一個群組最多 10 人，動態 24 小時後刪除。
- 讀了什麼、送了什麼、跑了什麼，每一條都附程式碼位置：**[SECURITY.md](SECURITY.md)**（英文）。

**安裝**：要用「本機」對話（Claude 桌面版 Code 分頁選你自己電腦上的資料夾，或在終端機開 `claude`）；雲端對話連不到中繼，pane 也只會出現在你自己的電腦上。安裝指令同上面兩行，裝好後開新對話貼朋友給你的 `/friends join …`，或用 `/friends create <你的名字>` 自己開一個群組。

想先看程式碼再決定也可以：外掛本體就是 `mod/hooks/` 裡那幾個檔案；安裝包可以用這個 repo 重新打出來，sha256 會一樣（見 SECURITY.md）。
