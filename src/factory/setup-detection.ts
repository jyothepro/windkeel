import type { ExecutionEnvironment } from "@windkeel/verification/exec/environment.js";
import { parseSetup, validEntryName, type SetupSpec } from "@windkeel/verification/config.js";

export interface ProposedSetup {
  setup: SetupSpec;
  reasons: string[];
}

const LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "npm-shrinkwrap.json", "uv.lock", "poetry.lock", "requirements.txt", "go.mod"];
const MAKE_TARGETS = ["bootstrap", "setup", "deps"];

const SERVICE_TEMPLATES: Record<string, { start: string; ready: string }> = {
  postgres: {
    start: "sudo service postgresql start || pg_ctlcluster --skip-systemctl-redirect $(pg_lsclusters -h | awk 'NR==1{print $1, $2}') start",
    ready: "pg_isready",
  },
  redis: { start: "redis-server --daemonize yes", ready: "redis-cli ping" },
};

interface CheckoutReader {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string | null>;
  list(dir: string): Promise<string[]>;
}

function readerFor(env: ExecutionEnvironment, root: string): CheckoutReader {
  const at = (path: string) => `${root}/${path}`;
  return {
    exists: (path) => env.exists(at(path)),
    read: async (path) => ((await env.exists(at(path))) ? (await env.readFile(at(path))).toString("utf8") : null),
    list: async (dir) => ((await env.exists(at(dir))) ? (await env.listFiles(at(dir))).map((f) => f.path) : []),
  };
}

const safeName = (raw: string): string => {
  const name = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  return validEntryName(name) ? name : "setup";
};

function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export async function proposeSetup(env: ExecutionEnvironment, checkoutPath: string): Promise<ProposedSetup> {
  const files = readerFor(env, checkoutPath);
  const reasons: string[] = [];
  const commands: Array<{ name: string; run: string }> = [];
  const services: Array<{ name: string; start: string; ready: string }> = [];
  const cacheKeyFiles: string[] = [];
  const used = new Set<string>();
  const addCommand = (name: string, run: string) => {
    let unique = safeName(name);
    for (let n = 2; used.has(unique); n++) unique = `${safeName(name)}-${n}`;
    used.add(unique);
    commands.push({ name: unique, run });
  };

  for (const lock of LOCKFILES) {
    if (await files.exists(lock)) {
      reasons.push(`${lock}: the dependency install already covers it — no setup entry needed`);
    }
  }

  const makefileName = (await files.exists("Makefile")) ? "Makefile" : (await files.exists("makefile")) ? "makefile" : null;
  const makefile = makefileName ? await files.read(makefileName) : null;
  if (makefileName && makefile) {
    for (const target of MAKE_TARGETS) {
      if (new RegExp(`^${target}\\s*:(?!=)`, "m").test(makefile)) {
        addCommand(target, `make ${target}`);
        cacheKeyFiles.push(makefileName);
        reasons.push(`Makefile has a \`${target}\` target: suggested \`make ${target}\` as a setup command`);
      }
    }
  }

  const scripts = [
    ...(await files.list("scripts")).filter((p) => /^setup[^/]*$/.test(p)).map((p) => `scripts/${p}`),
    ...((await files.exists("bin/setup")) ? ["bin/setup"] : []),
  ];
  for (const script of scripts.sort()) {
    addCommand(script.replace(/\.[a-z]+$/, ""), `sh ${script}`);
    cacheKeyFiles.push(script);
    reasons.push(`${script} exists: suggested running it as a setup command (read it first — it is repository code)`);
  }

  for (const compose of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    const text = await files.read(compose);
    if (!text) continue;
    for (const [image, template] of Object.entries(SERVICE_TEMPLATES)) {
      if (!new RegExp(`^\\s*image:\\s*["']?(?:[\\w.-]+/)?${image}(?:[:@"'\\s]|$)`, "m").test(text)) continue;
      if (services.some((s) => s.name === image)) continue;
      services.push({ name: image, ...template });
      reasons.push(
        `${compose} runs a ${image} image: Windkeel does not run docker-compose, so suggested starting a ${image} ` +
          "installed in the sandbox image (declare it under `tools` if the image lacks it)",
      );
    }
  }

  for (const pin of [".tool-versions", ".nvmrc", ".node-version", ".python-version"]) {
    if (await files.exists(pin)) {
      reasons.push(`${pin} pins a toolchain version: the sandbox image provides its own toolchain; not converted`);
    }
  }

  const devcontainer = await files.read(".devcontainer/devcontainer.json");
  if (devcontainer) {
    try {
      const parsed = JSON.parse(stripJsonComments(devcontainer)) as { postCreateCommand?: unknown };
      const post = parsed.postCreateCommand;
      const run =
        typeof post === "string"
          ? post
          : Array.isArray(post) && post.every((p) => typeof p === "string")
            ? post.join(" ")
            : post && typeof post === "object"
              ? Object.values(post as Record<string, unknown>).filter((v): v is string => typeof v === "string").join(" && ")
              : "";
      if (run.trim()) {
        addCommand("devcontainer-post-create", run);
        cacheKeyFiles.push(".devcontainer/devcontainer.json");
        reasons.push(".devcontainer/devcontainer.json has a postCreateCommand: suggested it as a setup command");
      }
    } catch {
      reasons.push(".devcontainer/devcontainer.json could not be parsed; nothing suggested from it");
    }
  }

  const { setup, rejected } = parseSetup({
    commands,
    services,
    cacheKeyFiles: [...new Set(cacheKeyFiles)],
  });
  for (const r of rejected) reasons.push(`not suggested: ${r.value} — ${r.reason}`);
  return { setup: setup ?? { commands: [], services: [], secrets: [], egress: [], cacheKeyFiles: [] }, reasons };
}

export function proposesAnything(proposal: ProposedSetup): boolean {
  return proposal.setup.commands.length > 0 || proposal.setup.services.length > 0;
}
