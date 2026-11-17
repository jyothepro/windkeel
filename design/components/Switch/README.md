# Switch

Turns a setting on or off, taking effect immediately — *Gate pull requests*, *Seal with Sigstore*.

## The consumer provides

- `<button type="button" class="oq-switch" role="switch" aria-checked="false">`; toggle `aria-checked` on click.
- A label: either `aria-labelledby` pointing at visible text, or the `oq-switch-row` layout — `__title` and a one-line `__desc` on the left, the switch on the right.

## Don't

- Don't use a switch for something that only applies after *Save*; use a checkbox in the form.
- Don't label with the state (*On*); label with the setting.
