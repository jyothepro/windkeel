import { ApiError, apiMode } from "../lib/api.ts";

function connection(): { mode: "live" | "fixtures" | null; problem: string | null } {
  try {
    return { mode: apiMode(), problem: null };
  } catch (err) {
    return { mode: null, problem: err instanceof ApiError ? err.message : String(err) };
  }
}

export function ConnectionBanner() {
  const { mode, problem } = connection();
  return (
    <>
      {problem ? (
        <div className="console-fixtures" data-intent="danger" role="alert">
          {problem}
        </div>
      ) : null}
      {mode === "fixtures" ? (
        <div className="console-fixtures" role="status">
          Showing fixtures — no factory is connected. Set <code>WINDKEEL_API_URL</code> and <code>WINDKEEL_API_TOKEN</code> to read real runs.
        </div>
      ) : null}
    </>
  );
}
