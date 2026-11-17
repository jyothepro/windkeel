`formatDuration` in `src/duration.js` writes long durations as a large number of minutes: two hours reads as `120m 0s`. Durations of an hour or more should read as hours, minutes and seconds, e.g. `1h 0m 0s` and `2h 2m 2s`. Durations under an hour are unchanged. `parseDuration` reads durations back, and other code relies on it reading everything `formatDuration` writes.

## Acceptance criteria

- [ ] `formatDuration(3600)` returns `1h 0m 0s` and `formatDuration(7322)` returns `2h 2m 2s`
- [ ] durations under an hour format exactly as before
- [ ] `parseDuration(formatDuration(n)) === n` for every non-negative integer `n`, hours included
- [ ] `npm test` passes
