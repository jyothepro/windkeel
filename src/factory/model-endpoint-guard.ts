import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

export class UnsafeEndpointError extends Error {
  override readonly name = "UnsafeEndpointError";
}

const LOCALHOST_DEV_FLAG = "WINDKEEL_ALLOW_LOCALHOST_MODEL_BASE_URL";

export function allowLocalhostHttpFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env[LOCALHOST_DEV_FLAG]?.trim() === "1";
}

export interface EndpointGuardOptions {
  allowLocalhostHttp?: boolean;
  resolve?: (hostname: string) => Promise<string[]>;
}

const MAX_URL_LENGTH = 2048;
const LOCALHOST_NAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

const FORBIDDEN_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$|^metadata(\.|$)/i;

const RANGES: ReadonlyArray<[string, number, "ipv4" | "ipv6", string]> = [
  ["0.0.0.0", 8, "ipv4", "an unspecified address"],
  ["10.0.0.0", 8, "ipv4", "a private address"],
  ["100.64.0.0", 10, "ipv4", "a carrier-grade NAT address (and some clouds' metadata service)"],
  ["127.0.0.0", 8, "ipv4", "a loopback address"],
  ["169.254.0.0", 16, "ipv4", "a link-local address (and the cloud metadata service)"],
  ["172.16.0.0", 12, "ipv4", "a private address"],
  ["192.0.0.0", 24, "ipv4", "a reserved address"],
  ["192.0.2.0", 24, "ipv4", "a documentation address"],
  ["192.88.99.0", 24, "ipv4", "a reserved address"],
  ["192.168.0.0", 16, "ipv4", "a private address"],
  ["198.18.0.0", 15, "ipv4", "a benchmarking address"],
  ["198.51.100.0", 24, "ipv4", "a documentation address"],
  ["203.0.113.0", 24, "ipv4", "a documentation address"],
  ["224.0.0.0", 4, "ipv4", "a multicast address"],
  ["240.0.0.0", 4, "ipv4", "a reserved address"],
  ["::", 128, "ipv6", "an unspecified address"],
  ["::1", 128, "ipv6", "a loopback address"],
  ["::", 96, "ipv6", "an IPv4-compatible address"],
  ["100::", 64, "ipv6", "a discard address"],
  ["2001:db8::", 32, "ipv6", "a documentation address"],
  ["fc00::", 7, "ipv6", "a unique-local (private) address (and some clouds' metadata service)"],
  ["fe80::", 10, "ipv6", "a link-local address"],
  ["ff00::", 8, "ipv6", "a multicast address"],
];

const BLOCKS = RANGES.map(([network, prefix, family, reason]) => {
  const list = new BlockList();
  list.addSubnet(network, prefix, family);
  return { list, family, reason };
});

export function forbiddenAddressReason(address: string): string | null {
  const family = isIP(address);
  if (family === 0) return "not an IP address";
  if (family === 4) return reasonFor(address, "ipv4");

  const hextets = expandIPv6(address);
  if (!hextets) return "not an IP address";
  if (hextets.slice(0, 7).every((g) => g === 0)) {
    return hextets[7] === 1 ? "a loopback address" : hextets[7] === 0 ? "an unspecified address" : reasonFor(address, "ipv6");
  }
  const embedded = embeddedIPv4(hextets);
  if (embedded) {
    const inner = reasonFor(embedded, "ipv4");
    if (inner) return `${inner}, wrapped in IPv6`;
  }
  return reasonFor(hextets.map((h) => h.toString(16)).join(":"), "ipv6");
}

function reasonFor(address: string, family: "ipv4" | "ipv6"): string | null {
  for (const block of BLOCKS) {
    if (block.family === family && block.list.check(address, family)) return block.reason;
  }
  return null;
}

function expandIPv6(address: string): number[] | null {
  let text = address.split("%")[0]!.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted[1]!.split(".").map(Number);
    if (octets.some((o) => o > 255)) return null;
    text =
      text.slice(0, -dotted[1]!.length) +
      `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] => (part === "" ? [] : part.split(":").map((h) => parseInt(h, 16)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array<number>(Math.max(fill, 0)).fill(0), ...tail];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function embeddedIPv4(h: number[]): string | null {
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (h.slice(0, 5).every((g) => g === 0) && (h[5] === 0xffff || h[5] === 0)) return v4(h[6]!, h[7]!);
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((g) => g === 0)) return v4(h[6]!, h[7]!);
  if (h[0] === 0x2002) return v4(h[1]!, h[2]!);
  return null;
}

export function parseBaseUrl(raw: string, options: EndpointGuardOptions = {}): URL {
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > MAX_URL_LENGTH) {
    throw new UnsafeEndpointError(`a base URL must be a non-empty URL of at most ${MAX_URL_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeEndpointError("the base URL is not a URL");
  }
  if (url.username || url.password) {
    throw new UnsafeEndpointError("the base URL must not carry credentials; the key is stored separately");
  }
  if (url.search || url.hash) {
    throw new UnsafeEndpointError("the base URL must not have a query string or a fragment");
  }
  const host = bareHost(url.hostname);
  const localhost = LOCALHOST_NAMES.has(host);
  if (url.protocol === "http:") {
    if (!(localhost && options.allowLocalhostHttp)) {
      throw new UnsafeEndpointError(
        `the base URL must use https (plain http is allowed only for localhost, with ${LOCALHOST_DEV_FLAG}=1)`,
      );
    }
  } else if (url.protocol !== "https:") {
    throw new UnsafeEndpointError("the base URL must use https");
  }
  if (localhost && !options.allowLocalhostHttp) {
    throw new UnsafeEndpointError(`${host} is a loopback address`);
  }
  if (!localhost && FORBIDDEN_NAME.test(host)) {
    throw new UnsafeEndpointError(`${host} names a private host`);
  }
  if (!localhost && isIP(host) !== 0) {
    const reason = forbiddenAddressReason(host);
    if (reason) throw new UnsafeEndpointError(`${host} is ${reason}`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

export async function assertSafeBaseUrl(raw: string, options: EndpointGuardOptions = {}): Promise<string> {
  const url = parseBaseUrl(raw, options);
  const host = bareHost(url.hostname);
  if (!(LOCALHOST_NAMES.has(host) && options.allowLocalhostHttp) && isIP(host) === 0) {
    let addresses: string[];
    try {
      addresses = await (options.resolve ?? systemResolve)(host);
    } catch {
      throw new UnsafeEndpointError(`${host} does not resolve`);
    }
    if (addresses.length === 0) throw new UnsafeEndpointError(`${host} does not resolve`);
    for (const address of addresses) {
      const reason = forbiddenAddressReason(address);
      if (reason) throw new UnsafeEndpointError(`${host} resolves to ${address}, which is ${reason}`);
    }
  }
  return url.toString().replace(/\/$/, "");
}

export function guardedLookup(options: Pick<EndpointGuardOptions, "allowLocalhostHttp"> = {}): LookupFunction {
  return ((hostname: string, lookupOptions: object, callback: (...args: unknown[]) => void) => {
    dnsLookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as Array<{ address: string; family: number }>;
      const allowLoopback = options.allowLocalhostHttp === true && LOCALHOST_NAMES.has(bareHost(hostname));
      for (const entry of list) {
        const reason = forbiddenAddressReason(entry.address);
        if (reason && !(allowLoopback && reason === "a loopback address")) {
          return callback(new UnsafeEndpointError(`${hostname} resolves to ${entry.address}, which is ${reason}`));
        }
      }
      if ((lookupOptions as { all?: boolean }).all) return callback(null, list);
      const first = list[0];
      if (!first) return callback(new UnsafeEndpointError(`${hostname} does not resolve`));
      return callback(null, first.address, first.family);
    });
  }) as LookupFunction;
}

function systemResolve(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((entry) => entry.address));
    });
  });
}

function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}
