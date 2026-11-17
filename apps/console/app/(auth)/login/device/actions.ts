"use server";

import { ApiError, decideDevice } from "../../../../lib/api.ts";

export type DeviceDecision = { ok: true; decision: "approve" | "deny" } | { ok: false; message: string };

export async function decide(userCode: string, decision: "approve" | "deny"): Promise<DeviceDecision> {
  try {
    await decideDevice(userCode, decision);
    return { ok: true, decision };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 404 || err.status === 410) return { ok: false, message: "That code has expired or was already used. Run windkeel login again for a new one." };
      if (err.code === "session_required") return { ok: false, message: "Approving a terminal needs you signed in as yourself. Sign out and back in, then try again." };
      return { ok: false, message: err.message };
    }
    throw err;
  }
}
