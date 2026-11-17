import type { MetadataRoute } from "next";
import { site } from "../site.config.ts";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${site.url}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${site.url}/request-access`, changeFrequency: "monthly", priority: 0.6 },
  ];
}
