# Avatar

Shows who a message or action came from: a person (initials or photo) or the agent (cyan).

## The consumer provides

- `span.oq-avatar` with two initials, or an `<img alt="">` inside. Sizes: `--sm` 20px (lists), default 24px (transcript), `--lg` 32px (headers).
- For the agent: `oq-avatar--agent` with its mark, and `data-state="working"` while it acts — the ring pulses.
- The name next to it in text; the avatar is decorative (`aria-hidden="true"`).

## Don't

- Don't color people's avatars cyan, or the agent's anything else. Cyan means the agent.
