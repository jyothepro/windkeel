import type { SandboxHandle } from "../../../sandbox/provider.js";
import type { SandboxRegistry } from "../sandbox-registry.js";
import type { StageDeps } from "../stage-deps.js";

export interface AttachableWorkspace {
  readonly id: string;
  readonly role: "maker" | "verifier";
  readonly providerHandle: string | null;
}

export async function acquireWorkspaceHandle(
  deps: Pick<StageDeps, "sandboxes"> & { registry: SandboxRegistry },
  workspace: AttachableWorkspace,
): Promise<SandboxHandle | undefined> {
  const held = deps.registry.get(workspace.id);
  if (held) return held;
  if (!deps.sandboxes.capabilities.reattachable || !workspace.providerHandle) return undefined;
  try {
    const handle = await deps.sandboxes.attach({
      role: workspace.role,
      handleId: workspace.providerHandle,
    });
    deps.registry.put(workspace.id, handle);
    return handle;
  } catch {
    return undefined;
  }
}
