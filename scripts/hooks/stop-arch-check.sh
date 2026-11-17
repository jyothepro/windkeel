#!/bin/sh
# Claude Code Stop hook: run the architecture and invariant gates before an agent finishes, so prose rules that
# arch-check enforces (migrations, ADR index, doc links, boundaries) fail in the session, not CI.
# Exit 2 hands the failure back to the agent. Skipped on the second stop to avoid a loop.
input=$(cat)
case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;; esac
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
# Always run, even with a clean tree: an agent that committed before stopping must still be
# checked. Both gates only read files, so they cost about a second.
for gate in arch-check invariant-check; do
  out=$(node "scripts/$gate.mjs" 2>&1) || { printf 'scripts/%s.mjs failed — fix before finishing:\n%s\n' "$gate" "$out" >&2; exit 2; }
done
exit 0
