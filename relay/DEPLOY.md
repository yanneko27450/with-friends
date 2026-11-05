# Run your own relay (Cloudflare, free plan)

The relay is the small server your group's status goes through. By default everyone uses the
official relay run by the project's developer. If you would rather keep your group's data in your own
Cloudflare account, one person (usually whoever creates the group) deploys their own relay once;
everyone else just needs the URL.

**Cost:** $0 on Cloudflare's free plan for a group of up to 5 people.
**Time:** about 5 minutes.

## What the relay stores

- Each member's display name, and a hash of their key (never the key itself), and the group name
- When each member was last seen, and per-conversation online/away state
- The current activity as two codes from a fixed list (for example `fixing-bugs` and `website`).
  No prompts, no file names, no free text. Activities are deleted after 24 hours.
- When someone leaves, their record is deleted. When the last person leaves, the whole group is deleted.

## Steps

You need [Node.js](https://nodejs.org) 22.18 or newer (wrangler needs Node 22, and the build reads TypeScript files directly) and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

1. Get the code, install and build:
   ```bash
   git clone https://github.com/yanneko27450/with-friends.git
   cd with-friends/relay/worker
   npm install
   node build_plugin.mjs --no-guide --no-app
   ```
   The build writes `relay/worker/public/` (a copy of the plugin for your friends to install). The relay can't start
   without this folder, so don't skip it. You'll build once more in step 3 when you know your relay's address.
2. Sign in to Cloudflare (this opens your browser):
   ```bash
   npx wrangler login
   ```
   No browser on this machine, or want to approve from your phone? Use
   `npx wrangler login --device`: it prints a link and a short code to enter there.
3. Deploy:
   ```bash
   npm run deploy
   ```
   If your account doesn't have a workers.dev subdomain yet, wrangler asks you to register one.
   At the end, wrangler prints your relay URL, such as
   `https://friends-status-relay.<your-subdomain>.workers.dev`. Build again with that address and deploy
   once more, so the plugin copy on your relay points at your relay:
   ```bash
   node build_plugin.mjs --no-guide --no-app --base https://friends-status-relay.<your-subdomain>.workers.dev
   npm run deploy
   ```
4. Check it's up: open `<your relay URL>/health` in a browser. You should see `{"ok":true}`.

## Use it in Claude Code

The person who creates the group points Claude Code at the relay once, then creates the group:

```text
/friends relay https://friends-status-relay.<your-subdomain>.workers.dev <key-id> <Ed25519-public-key>
/friends create <your name>
```

`/friends relay` takes only the address itself (`https://` plus the host name), with no path after it.

In the Friends pane, press "Copy invite". It copies one line that holds both the relay URL
and the invite, such as `https://friends-status-relay.<your-subdomain>.workers.dev#<invite>`.
Send it privately. Friends join with that one line:

```text
/friends join <the line you were sent> <your name>
```

## Friends install the plugin from your relay

The relay also hands out the plugin itself (the build in step 3 put `marketplace.json` and the
plugin zip in `public/`), so friends can install it without a GitHub repo. They run, in a terminal:

```bash
claude plugin marketplace add https://friends-status-relay.<your-subdomain>.workers.dev/marketplace.json
claude plugin install with-friends@with-friends
```

(In the Claude desktop app, typing `/plugin` only opens the settings page, so use these commands.)

When you change the plugin, raise `version` in `mod/.claude-plugin/plugin.json` before you build again.

## Chat switch (plugin 0.6.0 and later)

Chat is **off** on a new relay. With the switch off, the relay tells plugins (`GET /capability`) that chat is not available
and refuses every chat route, so friends see no chat tab. Only the exact value `1` turns it on; anything else (unset, `0`,
`true`) leaves it off. Use a Worker **secret**, not a plain variable, so a later `npm run deploy` doesn't reset it:

```bash
npx wrangler secret put FRIENDS_CHAT_ENABLED   # type 1 when asked
```

Check it: `<your relay URL>/capability` shows `"enabled":true`. Plugins notice the change within 5 minutes. To turn chat off
again, run `npx wrangler secret delete FRIENDS_CHAT_ENABLED`; plugins hide chat within 10 minutes and need no update. Each member
can use up to 5 devices for chat. Running the Node relay (`relay/server.mjs`) instead? Set the environment variable
`FRIENDS_CHAT_ENABLED=1` before starting it.

## Limits

- **5 people per group.** That keeps typical use under a sixth of the free plan's
  daily quota, with room for busy days. For bigger groups, upgrade the Cloudflare plan
  ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
- If the free daily quota runs out, the relay stops answering until the next day (UTC).
  Nothing is lost; the pane shows that the relay can't be reached.

## Remove it

1. Everyone runs `/friends leave`. The relay deletes each member as they leave and
   deletes the group when the last one is gone.
2. Then delete the Worker:
   ```bash
   cd relay/worker
   npx wrangler delete
   ```
