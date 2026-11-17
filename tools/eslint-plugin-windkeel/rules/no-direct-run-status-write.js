const OWNER = /(^|[\\/])src[\\/]factory[\\/]run-service\.ts$/;
const SQL_TOKEN = /--[^\r\n]*|\/\*[\s\S]*?\*\/|e'(?:\\.|''|[^'\\])*'|'(?:''|[^'])*'|"(?:""|[^"])*"|\$([a-z_][\w]*|)\$[\s\S]*?\$\1\$|[a-z_][\w$]*|[\[\](),.=;]/gi;
const SET_END = new Set(["from", "where", "returning", ";"]);

function identifier(token) {
  return token?.startsWith('"') ? token.slice(1, -1).replace(/""/g, '"') : token?.toLowerCase();
}

function setsStatus(tokens, start) {
  let depth = 0;
  let targetStart = start;
  let assigned = false;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    const word = token.toLowerCase();
    const distinctFrom = word === "from" && tokens[i - 1]?.toLowerCase() === "distinct";
    if (depth === 0 && SET_END.has(word) && !distinctFrom) break;
    if (token === "(" || token === "[") depth++;
    else if (token === ")" || token === "]") depth--;
    else if (depth === 0 && token === ",") {
      targetStart = i + 1;
      assigned = false;
    } else if (depth === 0 && token === "=" && !assigned) {
      const targets = tokens.slice(targetStart, i);
      if (targets[0] === "(" ? targets.some((name) => identifier(name) === "status") : identifier(targets[0]) === "status") {
        return true;
      }
      assigned = true;
    }
  }
  return false;
}

function sqlUpdatesRunStatus(text) {
  if (!/\bupdate\b/i.test(text)) return false;
  const tokens = (text.match(SQL_TOKEN) ?? []).filter((token) => !token.startsWith("--") && !token.startsWith("/*"));
  return tokens.some((token, index) => {
    if (token.toLowerCase() !== "update") return false;
    let table = index + 1;
    if (tokens[table]?.toLowerCase() === "only") table++;
    if (tokens[table + 1] === ".") table += 2;
    if (identifier(tokens[table]) !== "engineering_run") return false;
    for (let i = table + 1; i < tokens.length && tokens[i] !== ";"; i++) {
      if (tokens[i].toLowerCase() === "set") return setsStatus(tokens, i + 1);
    }
    return false;
  });
}

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return null;
}

function hasStatusKey(objectExpression) {
  return objectExpression.properties.some(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      ((property.key.type === "Identifier" && property.key.name === "status") ||
        (property.key.type === "Literal" && property.key.value === "status")),
  );
}

function sqlText(node) {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") return node.quasis.map((quasi) => quasi.value.cooked ?? "").join(" ");
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Run status moves only through advanceRun in src/factory/run-service.ts (ADR-0003)." },
    schema: [],
    messages: {
      call: "Set a run's status through advanceRun (src/factory/run-service.ts), not updateEngineeringRun({ status }).",
      sql: "Set engineering_run.status through advanceRun (src/factory/run-service.ts), not raw SQL.",
    },
  },
  create(context) {
    if (OWNER.test(context.filename)) return {};
    return {
      CallExpression(node) {
        if (calleeName(node.callee) !== "updateEngineeringRun") return;
        for (const argument of node.arguments) {
          if (argument.type === "ObjectExpression" && hasStatusKey(argument)) {
            context.report({ node: argument, messageId: "call" });
          }
        }
      },
      "Literal, TemplateLiteral"(node) {
        const text = sqlText(node);
        if (text !== null && sqlUpdatesRunStatus(text)) context.report({ node, messageId: "sql" });
      },
    };
  },
};
