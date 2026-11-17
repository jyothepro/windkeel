import path from "node:path";

const SERVER_PACKAGES = [/^pg(-.*)?$/, /^pg-boss$/, /^@windkeel\/factory(\/.*)?$/, /^@vercel\/sandbox(\/.*)?$/, /^@aws-sdk\//, /^workflow(\/.*)?$/];

function consoleRoot(filename) {
  const normalized = filename.split("\\").join("/");
  const marker = "/apps/console/";
  const index = normalized.lastIndexOf(marker);
  return index === -1 ? null : normalized.slice(0, index + marker.length - 1);
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "The console never imports the factory, its database driver or its cloud SDKs; they would land in a browser bundle.",
    },
    schema: [],
    messages: {
      serverPackage: "\"{{source}}\" is factory-side. The console reads the control plane API instead.",
      outsideConsole: "\"{{source}}\" reaches into factory or app code outside apps/console. Copy the value and pin it with a drift test (see lib/run-states.ts).",
    },
  },
  create(context) {
    const root = consoleRoot(context.filename);
    if (root === null) return {};

    function check(node, source) {
      if (typeof source !== "string") return;
      if (SERVER_PACKAGES.some((pattern) => pattern.test(source))) {
        context.report({ node, messageId: "serverPackage", data: { source } });
        return;
      }
      if (!source.startsWith(".")) return;
      const resolved = path.posix.resolve(path.posix.dirname(context.filename.split("\\").join("/")), source);
      const repoRoot = root.slice(0, -"/apps/console".length);
      const serverSide = ["src", "packages", "apps"].map((dir) => `${repoRoot}/${dir}/`);
      if (resolved.startsWith(`${root}/`) || !serverSide.some((dir) => resolved.startsWith(dir))) return;
      context.report({ node, messageId: "outsideConsole", data: { source } });
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") check(node, node.source.value);
      },
    };
  },
};
