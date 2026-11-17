import type { SandboxHandle } from "../../sandbox/provider.js";

export class SandboxRegistry {
  private readonly byWorkspaceId = new Map<string, SandboxHandle>();

  put(workspaceId: string, handle: SandboxHandle): void {
    this.byWorkspaceId.set(workspaceId, handle);
  }

  get(workspaceId: string): SandboxHandle | undefined {
    return this.byWorkspaceId.get(workspaceId);
  }

  forget(workspaceId: string): void {
    this.byWorkspaceId.delete(workspaceId);
  }

  entries(): Array<[string, SandboxHandle]> {
    return [...this.byWorkspaceId.entries()];
  }

  get size(): number {
    return this.byWorkspaceId.size;
  }
}
