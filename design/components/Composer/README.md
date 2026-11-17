# Composer

Where you instruct the agent: a textarea that grows with the message, over a toolbar with context and Send.

## The consumer provides

- `form.oq-composer` holding `textarea.oq-composer__input` (with a `label`, visually hidden if needed) and `div.oq-composer__toolbar`.
- Toolbar, left to right: ghost icon Buttons (*Attach*, *Mention a file*), `span.oq-composer__chip`s for attached context (a file, a branch), `span.oq-composer__spacer`, then the primary `oq-button--sm` Send with its `⌘↵` hint.
- While the agent is working, Send becomes a default *Stop* button with a square icon; typing still works and queues.
- `field-sizing: content` grows the textarea where supported; elsewhere grow it from script.

## Don't

- Don't disable the composer while the agent works; people think ahead.
- Don't submit on bare Enter in multi-line mode; ⌘/Ctrl+Enter sends.
