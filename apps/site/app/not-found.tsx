import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false },
};

export default function NotFound() {
  return (
    <div className="container-page py-24 md:py-32">
      <p className="eyebrow">404</p>
      <h1 className="mt-3 text-[clamp(2rem,1.4rem+2.4vw,3rem)] font-semibold leading-tight tracking-tight">
        This page is off course.
      </h1>
      <p className="mt-4 max-w-md text-lg text-muted">The address may be mistyped, or the page has moved.</p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <a href="/" className="btn btn-primary">
          Back to the home page
        </a>
        <a href="/#faq" className="btn btn-secondary">
          Read the FAQ
        </a>
      </div>
    </div>
  );
}
