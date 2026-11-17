# Message

One turn in a run's transcript — your instruction or the agent's reply — with who said it and when.

## The consumer provides

- `article.oq-message` (add `oq-message--you` for the person's turns) holding an Avatar and a column with `div.oq-message__header` (`span.oq-message__author`, then a `time`) and `div.oq-message__body`.
- Body content in order of the agent's work: prose `p`, `AgentStep`s, a `Terminal`, a `DiffView`. The body stacks them with `space-2`.
- Markdown rendered to plain elements; inline code picks up the sunken style.

## Don't

- Don't use chat bubbles for the agent; its turns are documents, full width of the column.
- Don't show the agent's name as a brand (*Windkeel AI*); it's *Windkeel*.
