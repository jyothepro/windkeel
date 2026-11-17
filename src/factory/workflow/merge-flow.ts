async function mergePullRequestStep(runMergeId: string): Promise<{ status: string }> {
  "use step";
  const userMerge = await import("../user-merge.js");
  const outcome = await userMerge.executeRunMergeFromEnvironment(runMergeId);
  return { status: outcome.status };
}

export async function orqonMergePullRequestFlow(runMergeId: string): Promise<{ status: string }> {
  "use workflow";
  return await mergePullRequestStep(runMergeId);
}
