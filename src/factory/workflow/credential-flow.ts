async function validateCredentialStep(
  organizationId: string,
  credentialId: string,
): Promise<{ status: string }> {
  "use step";
  const validation = await import("../model-credential-validation.js");
  const outcome = await validation.validateModelCredentialFromEnvironment(organizationId, credentialId);
  return { status: outcome.status };
}

export async function orqonValidateModelCredentialFlow(
  organizationId: string,
  credentialId: string,
): Promise<{ status: string }> {
  "use workflow";
  return await validateCredentialStep(organizationId, credentialId);
}
