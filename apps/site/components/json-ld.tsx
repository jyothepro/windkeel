import { site } from "../site.config.ts";

const data = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: site.name,
  url: site.url,
  description: site.description,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
  offers: [
    { "@type": "Offer", name: "Windkeel Gate", price: "0", priceCurrency: "USD" },
    { "@type": "Offer", name: "Starter", price: "20", priceCurrency: "USD" },
    { "@type": "Offer", name: "Pro", price: "50", priceCurrency: "USD" },
    { "@type": "Offer", name: "Team", price: "100", priceCurrency: "USD" },
    { "@type": "Offer", name: "Scale", price: "250", priceCurrency: "USD" },
  ],
};

export function JsonLd() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
