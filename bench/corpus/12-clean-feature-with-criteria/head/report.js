export function format(rows, { json = false } = {}) {
  if (json) return JSON.stringify(rows);
  return rows.map((r) => `${r.name}: ${r.value}`).join("\n");
}
