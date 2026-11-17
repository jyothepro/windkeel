/**
 * Formats a number of seconds for a person to read: `65` is `1m 5s`, `5` is `5s`.
 */
export function formatDuration(totalSeconds) {
  if (!Number.isInteger(totalSeconds) || totalSeconds < 0) {
    throw new RangeError("totalSeconds must be a non-negative integer");
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Reads a duration written the way `formatDuration` writes one back into seconds.
 * `"1m 5s"` is `65`. Anything it does not recognise is a `SyntaxError`.
 */
export function parseDuration(text) {
  const match = /^(?:(\d+)m )?(\d+)s$/.exec(String(text).trim());
  if (!match) throw new SyntaxError(`not a duration: ${JSON.stringify(text)}`);
  return Number(match[1] ?? 0) * 60 + Number(match[2]);
}
