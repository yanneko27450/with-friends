# Run your own relay (Cloudflare, free plan)

The relay is the small server your group's status goes through. By default everyone uses the
official relay run by the project's developer. If you would rather keep your group's data in your own
Cloudflare account, one person (usually whoever creates the group) deploys their own relay once;
everyone else just needs the URL.

**Cost:** $0 on Cloudflare's free plan for a group of up to 10 people.
**Time:** about 5 minutes.

## What the relay stores

- Each member's display name, and a hash of their key (never the key itself), and the group name
- When each member was last seen, and per-conversation online/away state
- The current activity as two codes from a fixed list (for example `fixing-bugs` and `website`).
  No prompts, no file names, no free text. Activities are deleted after 24 hours.
- When someone leaves, their record is deleted. When the last person leaves, the whole group is deleted.

## Steps

You need [Node.js](https://nodejs.org) 20.15 or newer and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

1. Get the code and install:
   ```bash
   cd relay/worker
   npm install
   ```
2. Sign in to Cloudflare (this opens your browser):
   ```bash
   npx wrangler login
   ```
   No browser on this machine, or want to approve from your phone? Use
   `npx wrangler login --device`: it prints a link and a short code to enter there.
3. Deploy:
   ```bash
   npx wrangler deploy
   ```
   At the end, wrangler prints your relay URL, such as
   `https://friends-status-relay.<your-subdomain>.workers.dev`.
4. Check it's up: open `<your relay URL>/health` in a browser. You should see `{"ok":true}`.

## Use it in Claude Code

The person who creates the group points Claude Code at the relay once, then creates the group:

```text
/friends relay https://friends-status-relay.<your-subdomain>.workers.dev
/friends create <your name>
```

In the Friends pane, press "Copy invite". It copies one line that holds both the relay URL
and the invite, such as `https://friends-status-relay.<your-subdomain>.workers.dev#<invite>`.
Send it privately. Friends join with that one line:

```text
/friends join <the line you were sent> <your name>
```

## Serve the plugin from your relay (optional)

The relay can also hand out the plugin itself, so friends install it without a GitHub repo.
`node build_plugin.mjs --base https://friends-status-relay.<your-subdomain>.workers.dev` writes
`public/marketplace.json` and the plugin zip; `npx wrangler deploy` uploads them with the Worker.
Friends then run:

```text
/plugin marketplace add https://friends-status-relay.<your-subdomain>.workers.dev/marketplace.json
/plugin install with-friends@with-friends
```

When you change the plugin, raise `version` in `mod/.claude-plugin/plugin.json` before you build again.

## Limits

- **10 people per group.** That keeps typical use under a third of the free plan's
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
