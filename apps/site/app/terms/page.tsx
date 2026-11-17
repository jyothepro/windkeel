import type { Metadata } from "next";
import { PlaceholderPage } from "../../components/placeholder-page.tsx";

export const metadata: Metadata = {
  title: "Terms",
  alternates: { canonical: "/terms" },
  robots: { index: false },
};

export default function TermsPage() {
  return <PlaceholderPage title="Terms" what="terms of service text from the owner" />;
}
