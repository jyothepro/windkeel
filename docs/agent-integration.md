# Using Windkeel from Claude Code or Codex

Windkeel verifies a change with a **different vendor's model** from the one that wrote it
([ADR-0010](adr/0010-maker-checker-model-policy-pre-byok.md)), in a **fresh sandbox** that never
held the maker's credentials ([ADR-0004](adr/0004-verification-runs-in-a-fresh-independent-sandbox.md)).

That is the one review a coding agent cannot perform on itself, however it is prompted. So the
integration is worth having for a specific reason: an agent that can submit work to Windkeel and read
the verdict gets an independent check on its own output.

Both Claude Code and Codex speak MCP over stdio, so there is one server rather than two plugins.

## Setup

```bash
npm install -g windkeel       # installs `windkeel` and its alias `windkeel`; or use npx below
windkeel login --url https://your-ingress.vercel.app
windkeel whoami                  # who you are, your orgs, what this token can do
```

`windkeel login` is a device flow, like `gh auth login`: it prints a one-time code, opens the console
in your browser, and once you approve there it stores a token for this machine in
`~/.config/windkeel/credentials.json` (mode 0600; `$XDG_CONFIG_HOME` is respected). No secret is ever
pasted into a terminal. Useful flags: `--scope read|execute|approve|admin` (default `execute`),
`--no-browser` on a machine without one, and `--with-token` to store an existing token read from
stdin (`windkeel login --with-token < token.txt` — never as a flag, which would land in shell history).
`windkeel logout` revokes the token on the server and then deletes the file.

## Give the agent its own token, scoped to what it should do

**Do not hand an agent your own login.** Mint a token for it, named after it, with only the
permissions it needs:

```bash
windkeel token create --name claude-code --scope read
```

The secret is printed once and never again. With `--scope read` the agent can list runs, follow
them and read verdicts, and nothing else — it cannot submit work, cancel, steer or approve. Use
`--scope execute` to let it submit tasks, cancel and send guidance; `approve` adds approving
criteria, which is a decision a person should normally keep.

| Preset | Permissions | What the agent's tool list contains |
|---|---|---|
| `read` | `runs.read` | whoami, list/get runs, events, attempts, cost, queue, messages, repositories |
| `execute` | + `runs.write` | the above, plus submit, cancel, guide |
| `approve` | + `runs.approve` | the above, plus approve |
| `admin` | all seven | the above, plus list secret names (`secrets.manage`) |

Or name permissions exactly with `--permissions runs.read,secrets.manage`. `--org <id>` pins the token
to one organization, and `--expires-in-days <n>` makes it lapse on its own. A token can never do
more than your own role in the organization allows: an admin-scoped token held by a viewer can only
view.

**The MCP server lists only the tools the token can use.** On start, `windkeel mcp` asks `/v1/self`
what the credential can do and offers only those tools, so an agent given a read-only token *sees* a
read-only Windkeel and never plans around a cancel it would be refused. (If `/v1/self` cannot be
reached, every tool is listed and the API refuses what the token cannot do.) When the API does
refuse for a missing permission, the tool error says which one and the `windkeel token create` command
a person should run.

`windkeel token list` shows every token you own, with its prefix, permissions and last use;
`windkeel token revoke <id>` kills one.

### Which credential the CLI and the server use

`WINDKEEL_API_TOKEN` and `WINDKEEL_API_URL` in the environment win whenever they are set; otherwise the
stored login is used. `WINDKEEL_ORG` (or `--org <id>`) chooses the organization, then whatever
`windkeel org use <id>` stored. A stored token is only ever sent to the URL that issued it — pointing
`WINDKEEL_API_URL` at another deployment without also setting `WINDKEEL_API_TOKEN` is refused, rather than
sending one deployment's credential to another. `windkeel whoami` prints which source is in effect.

### Claude Code

```bash
TOKEN=$(windkeel token create --name claude-code --scope read --json | jq -r .secret)
claude mcp add windkeel \
  --env WINDKEEL_API_URL=https://your-ingress.vercel.app \
  --env WINDKEEL_API_TOKEN=$TOKEN \
  -- windkeel mcp
```

Or commit a project-scoped `.mcp.json` so a team shares it — **with the token left to the
environment**, never written into a file that goes into git:

```json
{
  "mcpServers": {
    "windkeel": {
      "command": "npx",
      "args": ["-y", "windkeel", "mcp"],
      "env": {
        "WINDKEEL_API_URL": "https://your-ingress.vercel.app",
        "WINDKEEL_API_TOKEN": "${WINDKEEL_API_TOKEN}"
      }
    }
  }
}
```

Check it with `/mcp` inside Claude Code.

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.windkeel]
command = "windkeel"
args = ["mcp"]
env = { WINDKEEL_API_URL = "https://your-ingress.vercel.app" }
```

Leave `WINDKEEL_API_TOKEN` in your shell environment rather than in the config file.

## The tools

| Tool | |
|---|---|
| `windkeel_whoami` | Who the token is, and whether the database is reachable. Call this first when something fails. |
| `windkeel_list_repositories` | Repositories the factory can act on, with open-run counts. |
| `windkeel_submit_task` | Create a task and start a run. |
| `windkeel_list_runs` | Runs, newest first, filterable by state. |
| `windkeel_get_run` | The full report for one run. |
| `windkeel_run_events` | What a run has done, cursor-paginated. |
| `windkeel_run_attempts` | The repair history — *why* a run failed. |
| `windkeel_run_cost` | Spend per stage and kind, against the cap. |
| `windkeel_queue` | What is waiting, and on what. |
| `windkeel_approve` | Release a run parked for approval. **Marked destructive.** |
| `windkeel_cancel` | Stop a run. **Marked destructive.** |
| `windkeel_guide` | Queue something to say to a working run. **Marked destructive.** |
| `windkeel_messages` | What has been said to a run, and whether the worker heard it. |
| `windkeel_list_secrets` | A repository's secret *names* — never a value. |

The three write tools carry `destructiveHint`, so a host can prompt before they fire. An agent
cancelling a run because it misread a status should cost a confirmation, not a run. Everything else
here is read-only. Which of these an agent actually sees depends on its token — see the preset table
above.

There are deliberately no tools for members, invitations or tokens. An agent that can invite a
GitHub user can give a stranger the power to run code against your repositories, and one that can
mint tokens can mint itself a wider one than it was given. `windkeel member` and `windkeel token` are for
a person at a terminal.

## Two things an agent gets wrong without being told

**Write the acceptance criteria yourself.** `windkeel_submit_task` extracts criteria from the
description verbatim — a markdown checklist, or bullets under an "Acceptance criteria" heading. A
description with none takes a slower path: a model writes them and **a person must approve before
anything is spent** ([ADR-0012](adr/0012-m6-task-understanding-extract-first-generate-fallback.md)
§§1–2, §4). That path also has a sharper edge — a generated criterion can be *unsatisfiable*, true
of no possible change, which once failed a perfectly correct change and burned a repair turn
([#273](https://github.com/jyothepro/orqon/issues/273)). Criteria you write are cheaper and more
accurate than criteria inferred from your prose.

**Guidance changes *how*, never *what*.** `windkeel_guide` reaches the worker mid-run. But the run is
judged against criteria fixed when it started, so a message that changes the goal leaves the
verifier checking the old bar against different work. To change the goal, cancel and submit a new
task. The API refuses guidance outside `IMPLEMENTING`, `REPAIRING` and `VERIFYING`, because
anywhere else there is no session listening and the message would vanish.

**Guidance is queued, not instant — do not repeat it.** It becomes a *new turn* of the worker's
session, and a turn cannot start while one is running, so it lands at the next turn boundary: the
rest of the current turn plus up to one poll interval. The agent's output will look unchanged for a
while, and sending the same guidance again because of that produces two turns saying the same thing
and two turns' worth of tokens. Call `windkeel_messages` instead; it says `queued`, `delivered`,
`undeliverable` with a reason, or `superseded` if the run finished first.

## There is no tool for setting a secret, on purpose

`windkeel_list_secrets` returns names. Nothing here sets one, and the omission is not an oversight to
work around: a tool that stores a secret has to be handed the value, which puts a private-registry
token into a model's context window, sends it to a model vendor, and leaves it in whatever transcript
the host keeps. No care taken inside the tool prevents any of that, because the value has to cross
the boundary for the call to work.

Setting a secret is `windkeel secret set` in a terminal, where the value goes from a shell to one TLS
connection and nowhere else — and `@file` keeps it out of shell history too. If you are an agent that
has found a missing credential, say which name is missing and let the person set it.

## Following a run without replaying it

`windkeel_run_events` is cursor-paginated. Pass the previous call's `endCursor` as `after`; calling it
repeatedly from the start replays the whole run and wastes an agent's context on events it has
already read. The response carries the run's current status alongside the events, so one call
answers both "what happened" and "where is it now".

## The CLI, for a person

The same operations, for a terminal:

```bash
windkeel runs --status VERIFYING
windkeel show <run-id>
windkeel watch <run-id>              # follow to the end; exit 1 if it did not complete cleanly
windkeel attempts <run-id>           # the repair history
windkeel say <run-id> use the existing retry helper
windkeel approve <run-id>
windkeel submit --repo <uuid> --title "Fix the gauge" --description @task.md
```

`windkeel watch` exits with the run's own outcome, so it composes:

```bash
windkeel submit --repo $REPO --title "Fix the gauge" --description @task.md
windkeel watch $RUN && echo "verified" || echo "needs a human"
```

`--description @file` reads from disk on purpose: acceptance criteria are a checklist, and a
checklist typed into a shell argument loses its newlines and stops being one.

Organizations and people:

```bash
windkeel org list                    # your organizations and your role in each
windkeel org use acme                # act on this one from now on
windkeel member list
windkeel member invite grace --role member   # grace accepts by signing in to the console with GitHub
windkeel member invitations
windkeel member role <principal-id> viewer
windkeel member remove <principal-id>
```

## What still runs entirely locally

`windkeel verify`, `seal`, `verify-package`, `replay` and `bench` are the verification engine on your
own machine. They need **no server, no token and no network** and never will — that is the
local PR gate, and it does not acquire a dependency on a control plane
([ADR-0023](adr/0023-control-plane-api-reads-direct-writes-intents-updates-resume-from-a-cursor.md) §10).

So `windkeel verify --gate` in CI is unaffected by any of the above.

## When it does not work

| | |
|---|---|
| `WINDKEEL_API_URL is not set` | Run `windkeel login --url …`, or set the variables. The URL has no default: a CLI that assumed localhost would report an empty factory on the day you meant production. |
| `issued by … and WINDKEEL_API_URL points at …` | Your stored login is for a different deployment than the variable names. Set `WINDKEEL_API_TOKEN` for that deployment too, or unset `WINDKEEL_API_URL`. |
| `403 forbidden`, "this token lacks runs.write" | The token's scope, or your role, does not allow the call. Create a wider token with the command printed. |
| `400 organization_required` | You are in more than one organization. `windkeel org use <id>`, `--org <id>` or `WINDKEEL_ORG`. |
| `503 console_unconfigured` on login | The deployment has no console to approve a device login in. Use `windkeel login --with-token`. |
| `503 api_disabled` | The deployment has no `WINDKEEL_API_TOKEN`. The API refuses rather than falling open. |
| `401 unauthenticated` | The token is unknown, revoked or expired. `windkeel login` again. |
| Host says the server "failed to start" | Check its MCP logs. This server writes diagnostics to **stderr**; anything on stdout that is not a frame corrupts the stream. |
| `501 not_implemented` on secrets | Repository secrets are specified (ADR-0023 §9) and not built yet. |
