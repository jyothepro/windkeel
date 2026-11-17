const WORDS: Record<string, string> = {
  tenant_claimed:
    "Another organization already has this workspace connected. A workspace belongs to one organization at a time: disconnect it there first.",
  integration_not_connected:
    "Vercel Connect has no usable installation with that id. Check the id in the Vercel dashboard, and that the installation hasn't been removed or revoked.",
  tenant_unknown: "Vercel Connect didn't say which workspace that installation is, so its events couldn't be routed. Reinstall the connector and try again.",
  integration_misconfigured:
    "This deployment can't reach that provider's connector: its WINDKEEL_CONNECT_* setting is missing, or the project isn't linked to the connector.",
  integrations_disabled: "This deployment has no Vercel Connect token source, so it can't connect a workspace.",
  repository_not_granted: "That repository isn't granted to this organization. Grant it under Repository access first.",
  route_exists: "That scope already has a route on this connection. Change the existing route instead.",
  webhook_signing_unconfigured:
    "This deployment has no usable WINDKEEL_WEBHOOK_SIGNING_KEY (it must be at least 32 bytes), so it can't issue a webhook secret.",
  run_in_flight: "Not fired: this schedule's previous run is still going, and a schedule never runs two copies of its work at once.",
  run_requeued: "Not fired: the previous run had never started, so it was handed to the workflow again instead.",
  duplicate: "It was already fired at this instant.",
  fire_failed: "The schedule couldn't be fired. Nothing was left half-done, so it's safe to try again.",
  secrets_disabled:
    "This deployment has no WINDKEEL_SECRET_PUBLIC_KEY, so it can't store a key it can't read. An operator runs `windkeel-admin secrets keygen` and sets the public half on ingress.",
  label_taken: "A key with that label already exists here. Rotate it, or pick another label.",
  credential_revoked: "That key is revoked. Revoking is final: add a new one.",
  preset_name_taken: "There's already a preset with that name. Choose another, or edit that one.",
  org_budget_exhausted:
    "This organization's monthly budget is spent, so no new run starts. An admin can raise it under Settings → Billing, or it resets at the start of next month.",
  billing_suspended: "This organization's billing is suspended, so no new run starts. An admin can resolve it from Settings → Billing → Manage billing.",
  billing_unavailable: "This deployment has no billing provider (WINDKEEL_BILLING_PROVIDER), so there's no checkout or billing portal.",
  not_billed: "This organization isn't billed through this deployment, so there's nothing to manage.",
  invalid_invite: "That invite code isn't valid: it's unknown, already used, or expired. Ask whoever invited you for a new one.",
  invite_required: "Signup is invite-only. Enter the invite code you were sent.",
  already_has_account: "This GitHub account already belongs to a Windkeel organization. Sign in to that one, or ask its admin to invite you.",
  signup_disabled: "Self-serve signup isn't on for this deployment.",
  github_app_unnamed: "This deployment doesn't name its GitHub App (WINDKEEL_GITHUB_APP_SLUG), so it can't offer an install link.",
  invalid_state: "That installation link isn't valid any more. Start the installation again from here.",
  expired_state: "That installation link expired. Start the installation again from here.",
  installation_not_yours: "GitHub doesn't list that installation as one you can reach, so it wasn't linked.",
  installation_not_owned:
    "Only the owner of the GitHub account the App is installed on can link it: that user, or an admin of that organization.",
  installation_claimed: "That GitHub App installation already belongs to another Windkeel account.",
  permission_revoked: "You no longer hold repositories.manage in this organization, so the installation wasn't linked. Ask one of its admins.",
  installations_unverifiable: "This deployment can't check installations with GitHub (the App's client id and secret aren't set), so nothing was linked.",
};


export function refusalText(code: string, message: string): string {
  return WORDS[code] ?? message;
}
