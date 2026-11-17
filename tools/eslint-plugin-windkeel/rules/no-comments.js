const TOOL_DIRECTIVES = [
  /^\s*eslint-disable(-next-line|-line)?(\s|$)/,
  /^\s*eslint-enable(\s|$)/,
  /^\s*@ts-expect-error(\s|$)/,
  /^\s*@ts-ignore(\s|$)/,
  /^\/\s*<reference\s/,
];

export function isToolDirective(comment) {
  if (comment.type === "Shebang") return true;
  return TOOL_DIRECTIVES.some((pattern) => pattern.test(comment.value));
}

export default {
  meta: {
    type: "suggestion",
    docs: { description: "Ban code comments. A comment that explains code becomes a better name, a function, a test, or an ADR." },
    schema: [],
    messages: {
      banned: "Comments are banned. Rename, extract a function or constant, add a test, or move rationale to docs/adr.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (isToolDirective(comment)) continue;
          context.report({ loc: comment.loc, messageId: "banned" });
        }
      },
    };
  },
};
