import { enclosingDirectiveFunction } from "./workflow-directives.js";

const BANNED_CALLS = new Map([
  ["Date.now", "Date.now()"],
  ["Math.random", "Math.random()"],
  ["crypto.randomUUID", "crypto.randomUUID()"],
  ["crypto.getRandomValues", "crypto.getRandomValues()"],
  ["crypto.randomBytes", "crypto.randomBytes()"],
  ["performance.now", "performance.now()"],
  ["process.hrtime", "process.hrtime()"],
  ["process.hrtime.bigint", "process.hrtime.bigint()"],
]);
const BANNED_GLOBALS = new Set(["randomUUID", "randomBytes", "setTimeout", "setInterval", "setImmediate", "Date"]);

function memberPath(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    const object = memberPath(node.object);
    return object === null ? null : `${object}.${node.property.name}`;
  }
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Clock, randomness and timers are banned in modules declared pure and in \"use workflow\" bodies, which replay. Take a clock or id as an argument.",
    },
    schema: [
      {
        type: "object",
        properties: { pureFiles: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      banned: "{{what}} is ambient nondeterminism; {{where}} must be a function of its inputs. Pass the value in.",
    },
  },
  create(context) {
    const pureFiles = context.options[0]?.pureFiles ?? [];
    const normalized = context.filename.split("\\").join("/");
    const wholeFile = pureFiles.some((suffix) => normalized.endsWith(suffix));

    function scope(node) {
      if (wholeFile) return "this pure module";
      return enclosingDirectiveFunction(context.sourceCode.getAncestors(node)) === "use workflow" ? "a \"use workflow\" body" : null;
    }

    function report(node, what) {
      const where = scope(node);
      if (where !== null) context.report({ node, messageId: "banned", data: { what, where } });
    }

    return {
      CallExpression(node) {
        const path = memberPath(node.callee);
        if (path === null) return;
        if (BANNED_CALLS.has(path)) report(node, BANNED_CALLS.get(path));
        else if (node.callee.type === "Identifier" && BANNED_GLOBALS.has(path)) report(node, `${path}()`);
      },
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "Date" && node.arguments.length === 0) {
          report(node, "new Date()");
        }
      },
    };
  },
};
