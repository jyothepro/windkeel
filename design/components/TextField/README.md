# TextField

Collects a line or a block of text — a repository, a branch, an acceptance criterion — with its label, hint and error.

## The consumer provides

- A wrapper `div.oq-field` holding, in order: `label.oq-field__label` (with `for`), the control, then at most one of `p.oq-field__hint` or `p.oq-field__error`.
- The control: `<input class="oq-input">` or `<textarea class="oq-input">`. Add `oq-input--mono` for values that are code — repo names, refs, paths, commands.
- On error: `aria-invalid="true"` on the control, `aria-describedby` pointing at the error, and an error that says how to fix it (*Branch names can't contain spaces*).

## Don't

- Don't use the placeholder as the label.
- Don't show the hint and the error at the same time; the error replaces the hint.
- For chatting with the agent use the Composer, not a textarea.
