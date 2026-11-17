import type { Metadata } from "next";
import { Banner } from "../../../components/banner.tsx";
import { supabaseConfig } from "../../../lib/auth.ts";
import { safeNext } from "../../../lib/redirects.ts";
import { continueWithGitHub } from "./actions.ts";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  not_configured: "Sign-in isn't set up on this deployment.",
  oauth_start: "GitHub sign-in couldn't start. Try again in a moment.",
  oauth_callback: "GitHub sent you back without a sign-in. Try again, and approve the request on GitHub.",
  access_denied: "You declined the request on GitHub, so you're not signed in.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const configured = supabaseConfig() !== null;

  return (
    <>
      <div className="auth-card">
        <h1>Sign in to Windkeel</h1>
        <p>Windkeel uses your GitHub account. New here? The same button signs you up — once someone in your organization has invited your GitHub account.</p>
        {error ? <Banner intent="danger" title={ERRORS[error] ?? "Sign-in didn't complete."} /> : null}
        {configured ? (
          <form action={continueWithGitHub}>
            <input type="hidden" name="next" value={safeNext(next)} />
            <button type="submit" className="oq-button oq-button--primary oq-button--lg">
              <svg className="oq-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
              </svg>
              Continue with GitHub
            </button>
          </form>
        ) : (
          <Banner title="Sign-in isn't set up here">
            <p>
              This console runs on its server's operator token, so there's nothing to sign in to. To turn on sign-in, set{" "}
              <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>.
            </p>
          </Banner>
        )}
      </div>
      <p className="auth-fine">
        No invitation yet? Ask an admin of your Windkeel organization to invite your GitHub account from Settings.
      </p>
      {!configured ? (
        <p className="auth-fine">
          <a href="/runs">Go to the console</a>
        </p>
      ) : null}
    </>
  );
}
