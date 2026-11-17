import type { WindkeelApi, ScheduleInput, ScheduleView } from "../client/api.js";
import type { RemoteIo } from "./remote.js";

export const SCHEDULE_USAGE =
  "usage: windkeel schedule list [--json]\n" +
  "       windkeel schedule create --name <name> --repo <repository-id> --cron \"<cron>\" [--tz <zone>]\n" +
  "                             --title <title> --description <text|@file> [--risk low|medium|high]\n" +
  "                             [--spend-cap <usd>] [--wall-clock <seconds>] [--json]\n" +
  "       windkeel schedule update <schedule-id> [--name ..] [--repo ..] [--cron ..] [--tz ..]\n" +
  "                             [--title ..] [--description <text|@file>] [--risk ..]\n" +
  "                             [--spend-cap <usd>|none] [--wall-clock <seconds>|none]\n" +
  "                             [--enable|--disable] [--json]\n" +
  "         (`none` clears a cap back to the deployment default)\n" +
  "       windkeel schedule delete <schedule-id>\n" +
  "       windkeel schedule fire <schedule-id>\n" +
  "       windkeel schedule preview \"<cron>\" [--tz <zone>]\n";

export function capFlag(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  return raw.trim().toLowerCase() === "none" ? null : Number(raw);
}

export type ScheduleAction =
  | { kind: "list"; json?: boolean }
  | { kind: "create"; input: ScheduleInput; json?: boolean }
  | { kind: "update"; scheduleId: string; change: Partial<ScheduleInput>; json?: boolean }
  | { kind: "delete"; scheduleId: string }
  | { kind: "fire"; scheduleId: string; json?: boolean }
  | { kind: "preview"; cron: string; timezone: string; json?: boolean };

export async function scheduleCommand(api: WindkeelApi, io: RemoteIo, action: ScheduleAction): Promise<number> {
  switch (action.kind) {
    case "list": {
      const page = await api.listSchedules();
      if (action.json) {
        io.out(JSON.stringify(page.items, null, 2));
        return 0;
      }
      if (page.items.length === 0) {
        io.out("no schedules; create one with `windkeel schedule create`");
        return 0;
      }
      for (const s of page.items) io.out(formatSchedule(s));
      return 0;
    }
    case "create": {
      const { schedule } = await api.createSchedule(action.input);
      io.out(action.json ? JSON.stringify(schedule, null, 2) : `created ${formatSchedule(schedule)}`);
      return 0;
    }
    case "update": {
      const { schedule } = await api.updateSchedule(action.scheduleId, action.change);
      io.out(action.json ? JSON.stringify(schedule, null, 2) : `updated ${formatSchedule(schedule)}`);
      return 0;
    }
    case "delete": {
      await api.deleteSchedule(action.scheduleId);
      io.out(`deleted schedule ${action.scheduleId}`);
      return 0;
    }
    case "fire": {
      const ack = await api.fireSchedule(action.scheduleId);
      if (action.json) io.out(JSON.stringify(ack, null, 2));
      else io.out(`fired: task ${ack.taskId}, run ${ack.engineeringRunId}${ack.enqueued ? "" : " (not enqueued)"}`);
      return 0;
    }
    case "preview": {
      const preview = await api.previewSchedule(action.cron, action.timezone, 5);
      if (action.json) io.out(JSON.stringify(preview, null, 2));
      else {
        io.out(`"${preview.cron}" in ${preview.timezone} next fires at:`);
        for (const at of preview.nextFireTimes) io.out(`  ${at}`);
      }
      return 0;
    }
  }
}

export function formatSchedule(s: ScheduleView): string {
  const lines = [
    `${s.id}  ${s.name}  "${s.cron}" ${s.timezone}${s.enabled ? "" : "  (disabled)"}  -> ${s.repositoryId}`,
    `  title: ${s.title}`,
  ];
  if (s.enabled) lines.push(`  next: ${s.nextFireTimes.join(", ")}`);
  if (s.lastFiredAt || s.lastOutcome) lines.push(`  last: ${s.lastFiredAt ?? "—"} ${s.lastOutcome ?? ""}`.trimEnd());
  return lines.join("\n");
}
