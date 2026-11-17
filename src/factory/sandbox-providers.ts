import { FakeSandboxProvider } from "../sandbox/fake.js";
import { VercelSandboxProvider } from "../sandbox/vercel.js";
import type { SandboxProvider } from "../sandbox/provider.js";
import { sandboxCredentialsFromEnv } from "./stage-wiring.js";

export function providersFromEnv(): Record<string, SandboxProvider> {
  const providers: Record<string, SandboxProvider> = { fake: new FakeSandboxProvider() };
  const credentials = sandboxCredentialsFromEnv();
  if (credentials) providers["vercel"] = new VercelSandboxProvider(credentials);
  return providers;
}
