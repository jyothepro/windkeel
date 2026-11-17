export function parsePort(value) {
  const port = Number(value);
  // Seeded defect: the range check is gone, so 0 and 70000 are now accepted as ports.
  if (!Number.isInteger(port)) {
    throw new RangeError(`invalid port: ${value}`);
  }
  return port;
}
