import type { Metadata } from "next";
import { RequestAccessForm } from "../../components/request-access-form.tsx";

export const metadata: Metadata = {
  title: "Request access",
  description: "Windkeel Cloud is invite-only. Tell us about your team and the coding agents you use.",
  alternates: { canonical: "/request-access" },
};

export default function RequestAccessPage() {
  return (
    <div className="container-page grid gap-12 py-16 md:py-24 lg:grid-cols-[1fr_1.1fr] lg:gap-20">
      <div>
        <p className="eyebrow">Windkeel Cloud</p>
        <h1 className="mt-3 text-[clamp(2rem,1.4rem+2.4vw,3rem)] font-semibold leading-tight tracking-tight">
          Request access
        </h1>
        <p className="mt-4 max-w-md text-lg leading-relaxed text-muted">
          Sign-up is invite-only for now. Tell us a little about your team and the coding agents you already use.
        </p>
        <p className="mt-6 max-w-md text-muted">
          Want to start today? Windkeel Gate is source-available, free for noncommercial use, and verifies pull requests in your own CI, with your own
          model keys.
        </p>
        <a href="/#gate-cloud" className="btn btn-secondary mt-6">
          See Windkeel Gate
        </a>
      </div>
      <RequestAccessForm />
    </div>
  );
}
