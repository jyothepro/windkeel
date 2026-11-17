# windkeel

Independent verification for AI-written code. Run the evidence-based gate locally, or drive a
deployed Windkeel factory from a terminal, from CI, or from inside Claude Code and Codex.

```bash
npm install -g windkeel     # or: npx windkeel verify --gate
```

The package installs two names for the same command: `windkeel`, and `windkeel` for scripts written
before the rename. Both work; the examples use `windkeel`.

## Locally: no server, no token, no network

```bash
windkeel verify --gate            # verify a checkout and write an evidence package
windkeel verify-package .windkeel/evidence --require-signature
```

`verify`, `verify-package`, `annotate`, `seal`, `bench` and `replay` never talk to a server. That is
the local pull-request gate, and it does not acquire a dependency on a control plane.

## Against a deployment

Sign in once per machine. It is a device flow, like `gh auth login`: you approve the login in the
console, and a token for this machine is stored in `~/.config/windkeel/credentials.json` (mode 0600).

```bash
windkeel login --url https://your-ingress.vercel.app   # --scope read|execute|approve|admin, default execute
windkeel whoami                                        # who you are, your orgs, what this token can do
windkeel runs
windkeel submit --repo owner/name --title "…" --description @task.md   # file a task; its run starts
windkeel watch <run-id>
windkeel show <run-id>                                 # the run report
windkeel logout                                        # revokes the token, then deletes the file
```

For whoever runs the factory:

```bash
windkeel metrics                  # the factory's success, repair and merge rates, cost per verified PR
windkeel reap --dry-run           # which dead sandboxes are still billing, and why; then windkeel reap
windkeel capture <run-id>         # the agent's own transcript, out of the sandbox before it is reaped
```

Already have a token? `windkeel login --with-token < token.txt` reads it from stdin and checks it with
the server before saving. It is never accepted as a flag, which would put it in your shell history.

In CI, or for an agent, set `WINDKEEL_API_URL` and `WINDKEEL_API_TOKEN` instead. **The environment wins
over a stored login** whenever it is set. A stored token is only ever sent to the deployment that
issued it.

### Tokens

Give every agent and CI job its own token, scoped to what it needs, rather than your login:

```bash
windkeel token create --name claude-code --scope read   # the secret is printed once
windkeel token list
windkeel token revoke <id>
```

| Preset | Permissions |
|---|---|
| `read` | `runs.read` |
| `execute` | `runs.read`, `runs.write` |
| `approve` | `runs.read`, `runs.write`, `runs.approve` |
| `admin` | all of the above, plus `secrets.manage`, `repositories.manage`, `members.manage`, `tokens.manage`, `integrations.manage`, `schedules.manage`, `models.read`, `models.manage`, `batches.manage` |

Or `--permissions runs.read,secrets.manage`. A token never does more than your role in the
organization allows.

### Service principals

An automation should not hold your token: it stops working when you leave. Give it a service
principal instead — a non-human identity in one organization whose tokens outlive whoever made them.
Needs `tokens.manage`.

```bash
windkeel service-principal create --name nightly --role member
windkeel service-principal token create <principal-id> --name ci [--scope execute] [--expires-at 2027-01-01T00:00:00Z]
windkeel service-principal list
windkeel service-principal token list <principal-id>
windkeel service-principal token revoke <principal-id> <token-id>
windkeel service-principal delete <principal-id>        # revokes every token it holds
```

### Organizations and members

```bash
windkeel org list
windkeel org use <id|name>        # or --org <id> on any command, or WINDKEEL_ORG
windkeel member list
windkeel member invite <github-login> [--role admin|member|viewer]
windkeel member invitations
windkeel member role <principal-id> <role>
windkeel member remove <principal-id>
```

An invitee accepts by signing in to the console with that GitHub account.

## Inside Claude Code or Codex

`windkeel mcp` serves the control plane as MCP tools on stdio, using the same credential resolution as
every other command. It lists only the tools the token's permissions allow, so a `read` token gives
an agent a read-only tool set. There are no tools for secrets' values, members, invitations or
tokens, on purpose. See
[docs/agent-integration.md](https://github.com/jyothepro/windkeel/blob/main/docs/agent-integration.md).

`windkeel help` has every command and flag.
