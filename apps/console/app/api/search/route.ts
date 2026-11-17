import { unstable_rethrow } from "next/navigation";
import { listAllRepositories, listInboxRuns, listTasks } from "../../../lib/api.ts";
import { buildIndex } from "../../../lib/command-search.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [runs, tasks, repositories] = await Promise.all([listInboxRuns(), listTasks(), listAllRepositories()]);
    return Response.json({
      items: buildIndex({ runs, tasks: tasks.items, repositories: repositories.items }),
    });
  } catch (err) {
    unstable_rethrow(err);
    return Response.json(
      { error: err instanceof Error ? err.message : "The control plane didn't answer." },
      { status: 502 },
    );
  }
}
