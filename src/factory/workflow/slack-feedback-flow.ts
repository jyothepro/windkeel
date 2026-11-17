async function postMentionFeedbackStep(deliveryKey: string): Promise<{ status: string }> {
  "use step";
  const slack = await import("../../intake/slack.js");
  const outcome = await slack.postIgnoredMentionFeedbackFromEnvironment(deliveryKey);
  if (outcome.status === "released") throw new Error("slack mention feedback: transient failure, retrying");
  return { status: outcome.status };
}

export async function orqonSlackMentionFeedbackFlow(deliveryKey: string): Promise<{ status: string }> {
  "use workflow";
  return await postMentionFeedbackStep(deliveryKey);
}
