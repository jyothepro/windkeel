import type { ApiResult } from "./common.js";
import type { RouteName } from "./route.js";

type Contract = typeof import("@windkeel/api-contract");
let contract: Promise<Contract> | undefined;

export function validatingResponses(): boolean {
  return process.env["WINDKEEL_VALIDATE_RESPONSES"] === "1";
}

export async function validateResponse(route: RouteName, result: ApiResult): Promise<ApiResult> {
  if (result.status < 200 || result.status >= 300) return result;
  if (result.raw !== undefined || result.body instanceof Uint8Array) return result;
  contract ??= import("@windkeel/api-contract");
  const { routeResponses, isNonJsonRoute } = await contract;
  const schema = routeResponses[route];
  if (isNonJsonRoute(schema)) {
    return violation(route, [{ path: [], message: `route ${route} is declared non-JSON but answered ${result.status} with a JSON body` }]);
  }
  const wire: unknown = result.body === undefined ? undefined : JSON.parse(JSON.stringify(result.body));
  const parsed = schema.safeParse(wire);
  if (parsed.success) return result;
  return violation(
    route,
    parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
  );
}

function violation(route: RouteName, issues: Array<{ path: PropertyKey[]; message: string }>): ApiResult {
  const described = issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  console.error(`[windkeel] contract_violation on ${route}: ${JSON.stringify(described)}`);
  return {
    status: 500,
    body: {
      error: `the response for ${route} does not match the API contract: ${described.map((i) => `${i.path || "(body)"}: ${i.message}`).join("; ")}`,
      code: "contract_violation",
      route,
      issues: described,
    },
  };
}
