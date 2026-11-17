import { z } from "zod";
import {
  AcceptedSchema,
  pageSchema,
} from "./schemas.js";

export const iso = z.string();
export const id = z.string();

export const fileRoute = z.never().describe("file");
export const redirectRoute = z.never().describe("redirect");
export function isNonJsonRoute(schema: z.ZodType): boolean {
  return schema === fileRoute || schema === redirectRoute;
}

export const Deleted = z.object({ deleted: z.string() });
export const list = <T extends z.ZodType>(item: T) => pageSchema(item);
export const RunCommandAccepted = AcceptedSchema.extend({ engineeringRunId: id, outcome: z.string(), cursor: z.string() });
export const RunStarted = AcceptedSchema.extend({ taskId: id, engineeringRunId: id, enqueued: z.boolean() });
