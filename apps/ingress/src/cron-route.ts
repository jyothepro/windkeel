import { timingSafeEqual } from "node:crypto";

export function authorisedCron(header: string | string[] | undefined): boolean {
  const secret = process.env["CRON_SECRET"];
  if (!secret) return false;
  const value = Array.isArray(header) ? header[0] : header;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const received = Buffer.from(value ?? "", "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
