# Discord change-request loop

@-mention the bot in a watched channel with a change you want. It queues the
request, batches queued requests into one agent run, shows you what changed,
and waits for a reaction before anything is committed.

```
Discord ──mention──▶ queue ──batch──▶ claude -p ──▶ approval prompt
                                                         │
                                        🚀 land  ────────┼──▶ commit + push + restart server
                                        📦 park  ────────┤    (tunnel URL unchanged)
                                        🗑️ bin   ────────┘    revert working tree
```

One process: `npm run bot`. It also supervises the game server, because that's
what lets a landed change restart into a running server.

## Setup

1. Create an app at <https://discord.com/developers/applications> → **Bot** →
   Reset Token.
2. Same page, **Privileged Gateway Intents** → turn on **Message Content**.
   Without it `MessageCreate` fires with empty text.
3. Invite it with scope `bot` and permissions `68608`:
   `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot&permissions=68608`
4. `cp .env.example .env` and fill it in.
5. Stop your own `npm start` and `npm run tunnel` — see below.
6. `npm run bot`

Message Content is the only privileged intent needed; reactions aren't.

## What `npm run bot` starts

Three things, in order: the game server, the cloudflared tunnel, then the
worker. It posts the public URL to every watched channel once it's up.

```
**Online.** Server up on :2567. Play here: https://xyz.trycloudflare.com
```

`cloudflared` proxies to `localhost:2567` and doesn't care what's listening, so
restarting the server keeps the same address — a couple of seconds of 502 and
nothing else. The tunnel is deliberately a sibling of the server, never a
child: bouncing it is the one thing that would change the URL. Landed changes
restart the server and leave the tunnel alone.

The bot can only restart a process it spawned. If something is already on the
port at startup it logs `[server] unmanaged` and leaves it strictly alone;
landed changes then just tell you to bounce it yourself. So run `npm run bot`
*instead of* `npm start` and `npm run tunnel`, not alongside them.

`MANAGE_GAME_SERVER=false` and `MANAGE_TUNNEL=false` opt out of either half.
The tunnel is skipped automatically if `bin/cloudflared` is missing.

## The three reactions

| | What happens |
| --- | --- |
| 🚀 | Commit the touched files, push to `origin/<branch>`, restart the server if anything outside `public/` changed |
| 📦 | Save the change under `.queue/parked/<id>/`, put the working tree back. Re-apply later with `npm run queue:apply <id>` |
| 🗑️ | Put the working tree back, drop the change |

`public/` is served off disk, so client-only changes are live on refresh and
skip the restart.

## Your uncommitted work is safe

The tree here is permanently dirty, which shapes most of the design:

- **Reverting restores a snapshot, never `git checkout --`.** Every file git
  tracks is copied before the agent runs, and 📦/🗑️ restore *that*. Resetting to
  HEAD would delete whatever you had in progress in a file the agent happened
  to touch.
- **Commits are narrowed to the agent's paths.** Never `git add -A` across the
  repo.
- **One exception, and it's flagged.** If the agent edits a file you'd already
  modified, landing commits your changes in that file too — they're in the same
  file and can't be separated. The approval prompt lists any such file under
  "already had uncommitted work".
- **The agent can't commit, push, or start servers.** It runs under
  `--permission-mode acceptEdits`, so it can read and write files and nothing
  else. Landing is this process's job, only after a reaction.

## Restarts and the ledger

`.queue/ledger.json` maps Discord message id → status, so nothing is done twice.
The queue only tracks pending/claimed and a job leaves it the moment the
approval prompt is posted; everything after that is the ledger's.

On startup:

- `awaiting-decision` → re-read the prompt message's reactions, since one added
  while the process was down never fires an event. If there's a decision, act on
  it; otherwise say it's still waiting.
- `in-progress` → we died mid-agent. The tree may hold half-finished edits that
  can't be attributed, so it's marked failed and reported rather than guessed
  at. Check `git status`.

The pre-agent contents of touched files are persisted to `.queue/inflight/<id>/`
before the prompt goes out, so 📦 and 🗑️ still work after a restart.

Only one batch runs at a time — the agent edits the real working tree, so a
second batch starting before the first is resolved would interleave two sets of
changes with no way to tell them apart.

## Layout

| File | What it owns |
| --- | --- |
| `bot/index.ts` | Gateway, enqueue, reaction routing, process lifecycle |
| `bot/handler.ts` | `interpret()` — pure message → ignore / reject / enqueue |
| `bot/config.ts` | Env parsing |
| `worker/index.ts` | The pipeline: claim → agent → prompt → decision |
| `worker/snapshot.ts` | Capture/restore the working tree |
| `worker/ledger.ts` | Durable per-request status |
| `worker/game-server.ts` | Spawns and restarts the game server |
| `worker/tunnel.ts` | Runs cloudflared, captures the public URL |
| `worker/agent.ts` | Builds the batched prompt, runs `claude -p` |
| `worker/park.ts` | Set aside / re-apply |
| `worker/git.ts` | Narrow commits, push, diffstat |
| `queue/` | `JobQueue` and the on-disk backend |

## Scripts

```
npm run bot            # the whole loop
npm run queue:peek     # what's queued
npm run queue:apply    # list parked changes; pass an id to apply one
```
