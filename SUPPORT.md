# Getting help with Friends with Claude

## Reporting a bug

Open an issue in this repository's **Issues** tab and click **New issue**. You can choose one of three templates: "Bug report", "Feature request", or "Activity category looks wrong". You can also click the "Report a problem / 回報問題" link at the very bottom of the Friends with Claude pane to go straight to the issue page. For security problems, do **not** open an issue — follow [SECURITY.md](SECURITY.md) instead.

Please include:

1. **Plugin version.** Open the Friends with Claude pane (`/friends`). The version is shown at the bottom right, for example `v0.4.0`. In a terminal the pane is short, so the version line only appears when there is room. If the pane says a new version is available, mention that too.
2. **Claude Code version.** Run `claude --version` in a terminal. If you use the Claude desktop app, say so — the desktop app can ship a different Claude Code version from the `claude` on your PATH.
3. **Where you use it.** Desktop app, terminal, VS Code, or the mobile app. (The mobile app does not show the pane; only `/friends` command replies.)
4. **Operating system.** For example Windows 11, macOS 15, Ubuntu 24.04.
5. **What the plugin says.** Copy the exact text of:
   - the red error line in the pane, if there is one (for example `Can't reach the relay. Retrying automatically…`);
   - the reply of the `/friends` command you ran;
   - `/friends update` — whether it says you are up to date, or that it updated or failed (it also says "up to date" when it could not reach the install source to check, so tell us if you expected a newer version);
   - `/friends autoupdate` — shows whether auto-update is on or off;
   - `/friends relay` with nothing after it — shows which relay address you use (adding an address after it would change the relay, so don't). The default relay is fine to share; if you run your own private relay, you may replace the address with `<my relay>`.
6. **Steps to reproduce.** What you did, what you expected, and what happened instead.

## Wrong category shown?

The plugin classifies what you are doing into two codes from a fixed list: what kind of activity you are doing, and what kind of thing you are working on.

If the classification shown does not look right, please open an issue using the "Activity category looks wrong" template. In the template, pick from the lists the codes the pane shows and the codes they should be.

You do not need to describe your conversation or file contents, and please do not include them.

## What NOT to paste

Issues are public. Never paste:

- **Invite codes or invite links** (anything you copied with "Copy invite", or a `/friends join …` line). Anyone with it can join your group.
- **Member keys** or anything that looks like `Bearer …`.
- **Your conversation with Claude** — prompts, answers, file contents, or screenshots of them.
- **Your friends' names, your group name, or screenshots of the pane that show them.** If a screenshot helps, cover the names first.
- **The output of `/friends hidden`** (it lists folder paths on your computer) and any other file paths, usernames or computer names.

If we need something private to debug the problem, we will ask how to share it safely.

## Useful commands

| Command | What it does |
|---|---|
| `/friends` | Opens the Friends with Claude pane |
| `/friends help` | Lists all commands |
| `/friends pause` / `/friends resume` | Stops / starts sharing what kind of work you are doing |
| `/friends lang en` / `/friends lang zh-TW` | Switches the interface language |
| `/friends update` | Checks for a new version and installs it |
| `/friends autoupdate` | Shows whether auto-update is on (`/friends autoupdate on` or `off` to change it) |
| `/friends relay` | Shows which relay address you use (`/friends relay <url>` changes it) |
| `/friends name <new name>` | Changes the name your friends see |
| `/friends remove` | Group owner only: removes a friend after you confirm |

For all other commands (create, join, leave, avatar, …) run `/friends help`.

## 繁體中文

回報問題：到本 repo 的 Issues 分頁按 New issue，依情況選三種範本之一：
「Bug report」、「Feature request」或「Activity category looks wrong」；
也可以點面板最底下的「Report a problem / 回報問題」連結直接到問題頁。
安全問題不要開 issue，請照 SECURITY.md 的方式處理。

回報時請附：外掛版本、Claude Code 版本、在哪裡使用（桌面版、終端機、VS Code 或手機）、
作業系統、外掛顯示的確切文字，以及重現步驟（做了什麼、預期什麼、實際發生什麼）。
分類顯示不準時，用分類範本從清單選「面板顯示的」與「應該是的」兩個代碼即可，
不需要描述你的對話或檔案內容。

issue 是公開的，絕對不要貼：邀請碼或邀請連結、金鑰（例如 `Bearer …`）、
你和 Claude 的對話內容、朋友名字與群組名、資料夾路徑或電腦上的其他私人資訊。
如果截圖有幫助，請先把名字等私人資訊遮住再貼。
