export function format(rows) {
  return rows.map((r) => `${r.name}: ${r.value}`).join("\n");
}
