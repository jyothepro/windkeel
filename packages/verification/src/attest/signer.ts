import { signPackage, type SignResult } from "./sigstore.js";

export interface Signer {
  sign(packageDir: string): Promise<SignResult>;
}

export class CosignKeylessSigner implements Signer {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async sign(packageDir: string): Promise<SignResult> {
    return signPackage(packageDir, this.env);
  }
}
