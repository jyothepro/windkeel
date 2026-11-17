import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { candidateEnv } from "./candidate-env.js";
import type { ExecOptions, ExecResult, ExecutionEnvironment } from "./environment.js";

function killGroup(pid: number | undefined): void {
  if (!pid || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
  }
}

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  constructor(private readonly baseEnv: NodeJS.ProcessEnv = process.env) {}

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const spawnOptions = {
      cwd: options.cwd,
      encoding: "utf8" as const,
      maxBuffer: options.maxBuffer ?? Infinity,
      env: candidateEnv(this.baseEnv, options.env),
      detached: process.platform !== "win32",
    };
    const result = options.args
      ? spawnSync(command, options.args, spawnOptions)
      : spawnSync(command, { ...spawnOptions, shell: true });
    killGroup(result.pid);
    return {
      status: result.status,
      signal: result.signal ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error.message } : {}),
    };
  }

  async readFile(path: string): Promise<Buffer> {
    return readFileSync(path);
  }

  async writeFile(path: string, data: Buffer | string): Promise<void> {
    writeFileSync(path, data);
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(path);
  }

  async listFiles(dir: string): Promise<Array<{ path: string; bytes: number }>> {
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return [];
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((name) => {
        const p = join(d, name);
        const stat = lstatSync(p);
        if (stat.isDirectory()) return walk(p);
        return stat.isFile() ? [p] : [];
      });
    return walk(dir).map((absolute) => ({
      path: relative(dir, absolute).split(sep).join("/"),
      bytes: lstatSync(absolute).size,
    }));
  }

  async mkdtemp(prefix: string): Promise<string> {
    return mkdtempSync(join(tmpdir(), prefix));
  }
}
