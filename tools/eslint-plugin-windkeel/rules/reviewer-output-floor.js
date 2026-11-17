const FLOOR = 32_768;
const BUDGET_NAME = /^(max_tokens|max_completion_tokens|max_output_tokens|maxOutputTokens|maxTokens|DEFAULT_MAX_OUTPUT_TOKENS)$/;

function keyName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function numericValue(node) {
  if (node && node.type === "Literal" && typeof node.value === "number") return node.value;
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: `A model output budget written in provider code is at least ${FLOOR} tokens (bench/replay/RESULTS.md: 4096 truncated reviewers mid-thought).`,
    },
    schema: [],
    messages: {
      belowFloor: "{{name}} = {{value}} is below the {{floor}}-token floor; reviewers truncate in thinking before they answer.",
    },
  },
  create(context) {
    function check(nameNode, valueNode) {
      const name = keyName(nameNode);
      const value = numericValue(valueNode);
      if (name === null || value === null || !BUDGET_NAME.test(name) || value >= FLOOR) return;
      context.report({ node: valueNode, messageId: "belowFloor", data: { name, value: String(value), floor: String(FLOOR) } });
    }
    return {
      Property(node) {
        if (!node.computed) check(node.key, node.value);
      },
      VariableDeclarator(node) {
        check(node.id, node.init);
      },
      AssignmentPattern(node) {
        check(node.left, node.right);
      },
      AssignmentExpression(node) {
        if (node.left.type === "Identifier") check(node.left, node.right);
        else if (node.left.type === "MemberExpression" && !node.left.computed) check(node.left.property, node.right);
      },
    };
  },
};
