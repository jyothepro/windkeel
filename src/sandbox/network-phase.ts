

import type { Ecosystem } from "./dependencies.js";
import type { NetworkPolicy } from "./provider.js";

const ECOSYSTEM_HOSTS: Readonly<Record<Ecosystem, readonly string[]>> = {
  npm: [
    "registry.npmjs.org",
    "nodejs.org",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
  ],
  python: ["pypi.org", "files.pythonhosted.org"],
  go: ["proxy.golang.org", "sum.golang.org"],
};

const SYSTEM_TOOL_HOSTS: readonly string[] = [
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "cdn.amazonlinux.com",
  "dl-cdn.alpinelinux.org",
];

const SCANNER_HOSTS: readonly string[] = [
  "semgrep.dev",
  "osv-vulnerabilities.storage.googleapis.com",

  "pypi.org",
  "files.pythonhosted.org",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

const MAKER_BROWSER_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "cdn.playwright.dev",
  "playwright.download.prss.microsoft.com",
];

export interface InstallPhaseOptions {

  makerBrowser?: boolean | undefined;

  ecosystems?: readonly Ecosystem[] | undefined;

  systemTools?: boolean | undefined;

  scanners?: boolean | undefined;

  extraHosts?: readonly string[] | undefined;
}

export function installPhasePolicy(options: InstallPhaseOptions = {}): NetworkPolicy {
  const ecosystems = options.ecosystems ?? (["npm", "python", "go"] as const);
  const domains = new Set<string>([

    "github.com",
  ]);
  for (const ecosystem of ecosystems) {
    for (const host of ECOSYSTEM_HOSTS[ecosystem]) domains.add(host);
  }
  if (options.systemTools !== false) for (const host of SYSTEM_TOOL_HOSTS) domains.add(host);
  if (options.scanners !== false) for (const host of SCANNER_HOSTS) domains.add(host);
  if (options.makerBrowser === true) {
    for (const host of MAKER_BROWSER_HOSTS) domains.add(host);
    for (const host of SYSTEM_TOOL_HOSTS) domains.add(host);
  }
  for (const host of options.extraHosts ?? []) domains.add(host);

  return { mode: "allowlist", allowedDomains: [...domains].sort() };
}

export function executionPhasePolicy(
  modelApiDomain: string,
  additionalDomains: string[] = [],
): NetworkPolicy {
  return {
    mode: "allowlist",
    allowedDomains: [...new Set([modelApiDomain, ...additionalDomains])],
  };
}
