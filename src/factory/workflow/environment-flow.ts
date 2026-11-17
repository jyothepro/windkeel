async function buildEnvironmentSnapshotStep(
  organizationId: string,
  repositoryId: string,
): Promise<{ status: string }> {
  "use step";
  const host = await import("../environment-snapshot-host.js");
  return host.buildEnvironmentSnapshotFromEnvironment(organizationId, repositoryId);
}

export async function orqonBuildEnvironmentSnapshotFlow(
  organizationId: string,
  repositoryId: string,
): Promise<{ status: string }> {
  "use workflow";
  return await buildEnvironmentSnapshotStep(organizationId, repositoryId);
}
