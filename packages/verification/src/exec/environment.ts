export interface ExecOptions {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  maxBuffer?: number;
}

export interface ExecResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ExecutionEnvironment {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listFiles(dir: string): Promise<Array<{ path: string; bytes: number }>>;
  mkdtemp(prefix: string): Promise<string>;
}

const VERSION_PROBE: Record<string, string[]> = {
  gitleaks: ["version"],
};

export async function toolInstalled(
  execEnv: ExecutionEnvironment,
  command: string,
): Promise<boolean> {
  const probe = VERSION_PROBE[command] ?? ["--version"];
  return (await execEnv.exec(command, { args: probe })).status === 0;
}
