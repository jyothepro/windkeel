const ORG_SCOPED = /^\/(runs|tasks|queue|metrics|repositories)(\/|\?|$)/;

export function orgScoped(path: string, orgId: string | null): string {
  if (!orgId || !ORG_SCOPED.test(path)) return path;
  return `/orgs/${encodeURIComponent(orgId)}${path}`;
}
