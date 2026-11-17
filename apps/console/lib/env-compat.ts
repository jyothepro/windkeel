const LEGACY_PREFIX = "ORQON_";
const PREFIX = "WINDKEEL_";

function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const adopted: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY_PREFIX) || value === undefined) continue;
    const current = PREFIX + name.slice(LEGACY_PREFIX.length);
    if (env[current] !== undefined) continue;
    env[current] = value;
    adopted.push(current);
  }
  return adopted;
}

adoptLegacyEnv();
