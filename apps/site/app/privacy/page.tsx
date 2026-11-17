import type { Metadata } from "next";
import { PlaceholderPage } from "../../components/placeholder-page.tsx";

export const metadata: Metadata = {
  title: "Privacy",
  alternates: { canonical: "/privacy" },
  robots: { index: false },
};

export default function PrivacyPage() {
  return <PlaceholderPage title="Privacy" what="privacy policy text from the owner" />;
}
