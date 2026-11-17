export function hasDirective(functionNode, directive) {
  const body = functionNode.body;
  if (!body || body.type !== "BlockStatement") return false;
  for (const statement of body.body) {
    if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string") return false;
    if (statement.directive === directive) return true;
  }
  return false;
}

export const FUNCTION_NODES = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"];

export function enclosingDirectiveFunction(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const node = ancestors[index];
    if (!FUNCTION_NODES.includes(node.type)) continue;
    if (hasDirective(node, "use step")) return "use step";
    if (hasDirective(node, "use workflow")) return "use workflow";
  }
  return null;
}
