# Dialog

Asks for a decision that must be made before going on — stopping a run, deleting a workspace, approving a risky command.

## The consumer provides

- A native `<dialog class="oq-dialog">` opened with `showModal()` (focus trap, Esc and the backdrop come free).
- `div.oq-dialog__header` with `h2.oq-dialog__title` (a question: *Stop this run?*), `div.oq-dialog__body` saying what will happen, and `div.oq-dialog__footer` with the cancel action first and the confirming action last, labelled with the verb (*Stop run*, not *OK*).
- Focus on the least destructive action when it opens.

## Don't

- Don't use a dialog to show information; put it on the page.
- Don't confirm things that can be undone — do them and offer *Undo* in a Toast.
