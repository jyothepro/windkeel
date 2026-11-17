/**
 * Which environment variables name the project a sandbox is created in — and why the obvious
 * answer is wrong on ADR-0020's topology.
 *
 * This suite exists because of a failure that cost a full end-to-end run. `buildSandboxProvider`
 * read `VERCEL_PROJECT_ID`, which is correct for the container backing and silently wrong inside
 * a deployment: the platform injects that name itself, with the id of the project being run, and
 * a project variable of the same name does not override it. The factory therefore asked Vercel
 * to create the maker's sandbox inside the control plane's own project and got
 *
 *     Status code 403 is not ok: You don't have permission to create the vercel sandbox.
 *
 * at PROVISIONING — a message naming neither the project nor the variable. Everything upstream
 * (webhook, queue dispatch, classification, the criteria gate) had worked.
 *
 * So: the `WINDKEEL_SANDBOX_*` names win where they are set, the `VERCEL_*` names still work where
 * nothing else is, and inside a deployment the fallback is refused rather than guessed at.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSandboxProvider } from "../dist/factory/stage-wiring.js";

/** `buildSandboxProvider` reads only these two fields off the config. */
const config = { modelApiDomain: "api.openai.com", modelKeyEnvVar: "OPENAI_API_KEY" };
const noop = () => {};

const KEYS = [
  "WINDKEEL_SANDBOX_TOKEN",
  "WINDKEEL_SANDBOX_TEAM_ID",
  "WINDKEEL_SANDBOX_PROJECT_ID",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_DEPLOYMENT_ID",
];

/** Runs `body` with exactly `vars` set among `KEYS`, and restores whatever was there before. */
function withEnv(vars, body) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return body();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/**
 * Reached through the field rather than through behaviour on purpose: the alternative is
 * creating a real sandbox, and the whole point of this suite is that the wrong project id is
 * invisible until something real is created. `credentials` is `private` in TypeScript only.
 */
const projectOf = (provider) => provider.credentials.projectId;

test("the WINDKEEL_SANDBOX_* names win over the VERCEL_* ones", () => {
  withEnv(
    {
      WINDKEEL_SANDBOX_TOKEN: "sandbox-token",
      WINDKEEL_SANDBOX_TEAM_ID: "team_sandbox",
      WINDKEEL_SANDBOX_PROJECT_ID: "prj_sandboxes",
      VERCEL_TOKEN: "control-plane-token",
      VERCEL_TEAM_ID: "team_control",
      VERCEL_PROJECT_ID: "prj_control_plane",
    },
    () => {
      const { provider, mode } = buildSandboxProvider(config, noop);
      assert.equal(mode, "vercel");
      assert.equal(projectOf(provider), "prj_sandboxes");
      assert.equal(provider.credentials.teamId, "team_sandbox");
      assert.equal(provider.credentials.token, "sandbox-token");
    },
  );
});

test("the VERCEL_* names still work when nothing else is set", () => {
  withEnv({ VERCEL_TOKEN: "t", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "prj_container" }, () => {
    const { provider, mode } = buildSandboxProvider(config, noop);
    assert.equal(mode, "vercel");
    assert.equal(projectOf(provider), "prj_container");
  });
});

test("inside a deployment, falling back to VERCEL_PROJECT_ID is refused", () => {
  withEnv(
    {
      VERCEL_DEPLOYMENT_ID: "dpl_the_control_plane",
      VERCEL_TOKEN: "t",
      VERCEL_TEAM_ID: "team",
      VERCEL_PROJECT_ID: "prj_control_plane",
    },
    () => {
      assert.throws(
        () => buildSandboxProvider(config, noop),
        (err) =>
          /WINDKEEL_SANDBOX_PROJECT_ID/.test(err.message) &&
          // The message has to say *why*, or it reads as a variable someone forgot to copy.
          /platform's own id/.test(err.message),
        "the error must name the variable to set and say why the VERCEL_ one cannot be used",
      );
    },
  );
});

test("inside a deployment with WINDKEEL_SANDBOX_PROJECT_ID set, it is used", () => {
  withEnv(
    {
      VERCEL_DEPLOYMENT_ID: "dpl_the_control_plane",
      WINDKEEL_SANDBOX_TOKEN: "t",
      WINDKEEL_SANDBOX_TEAM_ID: "team",
      WINDKEEL_SANDBOX_PROJECT_ID: "prj_sandboxes",
      VERCEL_PROJECT_ID: "prj_control_plane",
    },
    () => {
      const { provider, mode } = buildSandboxProvider(config, noop);
      assert.equal(mode, "vercel");
      assert.equal(projectOf(provider), "prj_sandboxes");
    },
  );
});

test("with no credentials at all it still falls back to the local provider", () => {
  withEnv({}, () => {
    const { mode, provider } = buildSandboxProvider(config, noop);
    assert.equal(mode, "local");
    assert.equal(provider.name, "fake");
  });
});

/**
 * ORQ-14: the local provider clones and runs the repository's installer *on this host*, with this
 * process's environment. Inside a deployment that is the control plane's own secrets, so an
 * incomplete set of sandbox credentials must stop the stage rather than fall back to it.
 */
test("inside a deployment, a missing sandbox token or team id fails closed instead of going local", () => {
  for (const vars of [
    { WINDKEEL_SANDBOX_PROJECT_ID: "prj_sandboxes", WINDKEEL_SANDBOX_TEAM_ID: "team" },
    { WINDKEEL_SANDBOX_PROJECT_ID: "prj_sandboxes", WINDKEEL_SANDBOX_TOKEN: "t" },
    { WINDKEEL_SANDBOX_PROJECT_ID: "prj_sandboxes" },
  ]) {
    withEnv({ VERCEL_DEPLOYMENT_ID: "dpl_the_control_plane", ...vars }, () => {
      assert.throws(
        () => buildSandboxProvider(config, noop),
        (err) => /WINDKEEL_SANDBOX_TOKEN/.test(err.message) && /FakeSandboxProvider/.test(err.message),
        `must refuse with ${Object.keys(vars).join(", ")} only`,
      );
    });
  }
});
