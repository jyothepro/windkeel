import type { Metadata } from "next";
import { signedInAs } from "../../../lib/auth.ts";

export const metadata: Metadata = { title: "Not a member yet" };

export default async function NotAMemberPage() {
  const who = await signedInAs();
  const name = who?.githubLogin ? `@${who.githubLogin}` : (who?.email ?? "your GitHub account");
  return (
    <div className="auth-card">
      <h1>You're not in an organization yet</h1>
      <p>
        You're signed in as <strong>{name}</strong>, but no Windkeel organization has invited that account. An admin of your organization
        can invite it from <em>Settings → Members and invitations</em>. You'll get in the next time you sign in.
      </p>
      <p>Signed in with a different GitHub account than the one they invited? Sign out and use that one.</p>
      <form action="/auth/sign-out" method="post">
        <button type="submit" className="oq-button oq-button--lg">
          Sign out
        </button>
      </form>
    </div>
  );
}
