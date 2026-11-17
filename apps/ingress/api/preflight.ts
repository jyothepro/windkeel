import "../src/env-compat.js";
import { timingSafeEqual } from "node:crypto";
import {
  runDeploymentPreflight,
  scrubSecrets,
} from "@windkeel/factory/execution";

function authorised(header: string | undefined): boolean {
  const secret = process.env["CRON_SECRET"];
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const received = Buffer.from(header ?? "", "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export default async function handler(
  req: { headers: Record<string, string | string[] | undefined> },
  res: {
    status: (code: number) => typeof res;
    json: (body: unknown) => void;
  },
): Promise<void> {
  const header = req.headers["authorization"];
  if (!authorised(Array.isArray(header) ? header[0] : header)) {
    res.status(401).json({ ok: false });
    return;
  }

  try {
    const report = await runDeploymentPreflight();
    res.status(200).json(scrubSecrets(report, process.env));
  } catch (err) {
    res.status(500).json({ ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
