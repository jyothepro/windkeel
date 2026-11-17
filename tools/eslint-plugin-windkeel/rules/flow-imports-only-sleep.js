import { FUNCTION_NODES, enclosingDirectiveFunction, hasDirective } from "./workflow-directives.js";

function isTypeOnly(declaration) {
  if (declaration.importKind === "type" || declaration.exportKind === "type") return true;
  const specifiers = declaration.specifiers ?? [];
  return specifiers.length > 0 && specifiers.every((specifier) => specifier.importKind === "type" || specifier.exportKind === "type");
}

function isSleepFromWorkflow(declaration) {
  if (declaration.type !== "ImportDeclaration" || declaration.source.value !== "workflow") return false;
  return declaration.specifiers.length > 0 && declaration.specifiers.every(
    (specifier) =>
      specifier.importKind === "type" ||
      (specifier.type === "ImportSpecifier" && specifier.imported.type === "Identifier" && specifier.imported.name === "sleep"),
  );
}

function containsWorkflowFunction(program) {
  let found = false;
  const visit = (node) => {
    if (found || !node || typeof node.type !== "string") return;
    if (FUNCTION_NODES.includes(node.type) && hasDirective(node, "use workflow")) {
      found = true;
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === "string") visit(value);
    }
  };
  visit(program);
  return found;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "A module that declares a \"use workflow\" function imports nothing at runtime but sleep from workflow; dependencies load inside \"use step\" bodies.",
    },
    schema: [],
    messages: {
      staticImport: "A \"use workflow\" module may only import `sleep` from \"workflow\" (or types). Load \"{{source}}\" inside a \"use step\" body.",
      workflowDynamicImport: "Dynamic import inside a \"use workflow\" body. Move it into a \"use step\" function.",
    },
  },
  create(context) {
    let isWorkflowModule = false;
    return {
      Program(program) {
        isWorkflowModule = containsWorkflowFunction(program);
        if (!isWorkflowModule) return;
        for (const statement of program.body) {
          const isModuleLink =
            statement.type === "ImportDeclaration" ||
            ((statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") && statement.source);
          if (!isModuleLink || isTypeOnly(statement) || isSleepFromWorkflow(statement)) continue;
          context.report({ node: statement, messageId: "staticImport", data: { source: String(statement.source.value) } });
        }
      },
      ImportExpression(node) {
        if (!isWorkflowModule) return;
        if (enclosingDirectiveFunction(context.sourceCode.getAncestors(node)) === "use workflow") {
          context.report({ node, messageId: "workflowDynamicImport" });
        }
      },
    };
  },
};
