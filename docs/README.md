# Docs

Start with [CONTEXT.md](../CONTEXT.md) (vocabulary) and [AGENTS.md](../AGENTS.md) (commands, repo
map, conventions). The root [README](../README.md) covers the verification gate and its CLI.

## Find the doc for…

| You want to | Read |
| --- | --- |
| Understand the system | [CONTEXT.md § System map](../CONTEXT.md#system-map), then [ADR-0020](adr/0020-the-control-plane-is-vercel-end-to-end.md) (control plane) |
| Know why something is the way it is | [adr/README.md](adr/README.md) |
| Deploy or operate the factory, migrations, troubleshooting | [running-the-factory.md](running-the-factory.md) |
| Call the API | [control-plane-api.md](control-plane-api.md) |
| Connect GitHub / Slack / Linear / Jira / Sentry / webhooks | [integrations.md](integrations.md), [github-app.md](github-app.md), [webhook-intake.md](webhook-intake.md), [webhook-ingress.md](webhook-ingress.md) |
| Batches, schedules, sweeps, playbooks | [batches.md](batches.md), [schedules.md](schedules.md), [sweeps.md](sweeps.md), [playbooks.md](playbooks.md) |
| Use Windkeel from Claude Code or Codex | [agent-integration.md](agent-integration.md) |
| Console views and flows | [ui/console-ux.md](ui/console-ux.md), [../design/README.md](../design/README.md) |
| Security controls | [security/soc2-controls.md](security/soc2-controls.md) |
| What's next | [roadmap-integrated-assistant.md](roadmap-integrated-assistant.md), [../research/MILESTONES.md](../research/MILESTONES.md) |
| How agents work in this repo | [agents/](agents/) (issue tracker, triage labels, domain docs, competitive backlog) |

## History

[archive/](archive/) holds superseded plans and research. Don't implement from it.
