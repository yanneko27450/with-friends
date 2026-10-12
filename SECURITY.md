# Security and privacy: what this plugin reads, sends and runs

This file is for you and for your Claude. Every claim below points at the code that does it,
so you can check it instead of trusting it. If something here and the code disagree, the code wins:
please open an issue.

## What leaves your computer

| Where | What | Code |
|---|---|---|
| The relay your invite points to (default `https://friends-status-relay.friends-status-relay.workers.dev`) | The display name you choose (free text, up to 20 characters) and, when you create a group, the group name (up to 30) | `mod/hooks/register.tsx`: `relayCall(... '/groups', { name })`, `relayCall(... '/join', { invite, name })`; `relay/core.mjs` `cleanName` |
| The relay | Your status every 10–60 s while Claude Code is open: `state` (working / idle / offline), a random per-conversation id `conn`, `paused`, and, when it changes, `action` + `subject` | `statusBody()` in `mod/hooks/register.tsx` |
| The relay | `action` and `subject` are always codes from a fixed list, for example `fixing-bugs` + `website`. Never your words | `mod/hooks/taxonomy.ts`; `classifyActivity()` returns `other` unless the model's answer is in the list |
| The relay | Timing: the relay sees when each turn starts and ends (working / idle), to the second, and your IP address | `turn.start` / `turn.complete` handlers |
| The marketplace URL you installed from | A GET of `marketplace.json` each time a conversation starts, to see whether a newer version exists. This happens even if you are not in a group, and there is no switch to turn it off | `checkUpdate()`, `updateOnStart()` |

Apart from the two names above, nothing the plugin sends is free text. The relay also rejects
activity that is not in the code list (`relay/core.mjs`, `status()`), so an older or modified plugin
cannot send words in those fields either.

**The relay address comes from the invite.** Whoever made the invite chose the relay. Your name and
status go to that address, and plain `http://` is accepted (for local testing). Only accept invites
from people you know.

## What stays on your computer

- **Your prompt text.** When you send a message, the plugin takes that message, removes things
  that look like code, secrets, URLs, emails, file paths and numbers (`mod/hooks/redact.ts`), and asks
  your own Claude model to pick one code from the list (`$.model.classify` in `classifyActivity()`).
  That request goes through your normal Claude Code connection, the same as any other message,
  not to the relay. Only the chosen code is sent to the relay.
- Claude's replies, your files and tool output are never read by the plugin.
- The current folder path is read only to check it against the folders you hid with `/friends hide`; it is not sent.
  In a hidden folder your prompts are not classified at all and the activity is sent as `other` + `other`.
- **Your member key** is stored in plain text in Claude Code's plugin storage
  (`~/.claude/plugins/store/with-friends_*.json`). Anyone who can read that file can act as you in the group
  (see your status, change your name, leave). It cannot read anything else.

## Files and settings the plugin reads

- Its own `plugin.json` (to know its version)
- `~/.claude/plugins/known_marketplaces.json`: only the `with-friends` entry, to know where it was installed from.
  If you installed from a local folder marketplace, that folder's `.claude-plugin/marketplace.json` too
- The Claude desktop app's `config.json` (`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS): only the `locale` field, to pick Chinese or English the first time
- `%APPDATA%\Claude\claude-code\` (Windows): the folder list, to find the `claude` program for updates.
  It picks the highest version folder that contains `claude.exe` and does not check a signature;
  that folder is the Claude desktop app's own, in your user profile
- Environment variables: `USERPROFILE`, `HOME`, `CLAUDE_CONFIG_DIR`, `APPDATA` (to find the files above),
  `LC_ALL`, `LANG` (language)

`claude plugin validate` prints the environment and storage list too ("env reads", "state reads/writes").

## Programs the plugin runs

Only when you press **Update** in the pane, type `/friends update`, or turned on auto-update yourself:

```
claude plugin marketplace update with-friends
claude plugin update with-friends@with-friends
```

These are the official Claude Code commands. The arguments are fixed, there is no shell, they run in the
plugin's own folder with no input, and their output is not shown or sent anywhere (`runUpdate()`).

## Updates: who you are trusting

The install package comes from the marketplace URL you installed from, which is run by the same person
as the default relay. **If you turn on auto-update, whatever that server publishes next is installed
without asking you**, and it could be different code from this repository. Nothing technical stops that.

- Auto-update is off until you say yes (`askAutoUpdate()`); you can turn it off with `/friends autoupdate off`.
- With auto-update off, the version you have never changes until you run the update yourself.
  Before updating, you can check the new version as described below.
- Every version we publish gets a tag and a GitHub release here with its sha256. A version on the
  marketplace without a matching release is a reason not to update.

## What the relay stores

- Each member's display name and a SHA-256 hash of their key (never the key itself), and the group name
- When each member was last seen (`seenAt`), and per-conversation online state
- The last activity codes, deleted after 24 hours
- Leaving deletes your record; when the last person leaves, the group is deleted.
  If you remove the plugin without `/friends leave`, your name and key hash stay until you leave or the group is deleted.
- "Deleted" means removed from the database; the hosting provider (Cloudflare) can restore data for up to 30 days.

## What you cannot check from here

- **That the relay runs this exact code.** Nobody outside can prove what a server runs.
  The plugin itself only ever sends the fields listed above, so a hostile relay sees names, codes,
  timing and IP addresses, and nothing about your conversations, as long as you are running code you checked
  (see "Updates" above). You can also run your own relay (`relay/DEPLOY.md`) and use `/friends relay <url>`.
- **No professional security audit yet.** This is being tried with friends first.

## Checking that the install package is this code

The marketplace serves a zip built from this repository by `relay/worker/build_plugin.mjs`,
which uses fixed timestamps and a fixed file order:

```
node relay/worker/build_plugin.mjs --out ./check
```

(`--out` deletes and recreates that folder.) Compare the `sha256` it prints with the one in the live
`marketplace.json`, and with the release for that version on GitHub. The zip is compressed with the zlib
inside Node, so use the Node version noted in the release; the GitHub Actions workflow
`.github/workflows/verify-build.yml` rebuilds it on Linux and compares it with the live marketplace.
You can also just unzip the package and diff it against `mod/`.

## Reporting a problem

Open an issue on this repository. Please don't post your invite link: it lets anyone join your group.
