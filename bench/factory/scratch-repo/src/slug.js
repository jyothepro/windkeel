/**
 * Turns a title into a URL slug: lowercase ASCII letters and digits, runs of anything else
 * collapsed to a single `-`, no leading or trailing `-`.
 */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
