import type { Metadata } from "next";
import { Banner } from "../../../../components/banner.tsx";
import { apiMode, getDeviceRequest, getIdentity } from "../../../../lib/api.ts";
import { supabaseConfig } from "../../../../lib/auth.ts";
import { ADMIN_PERMISSIONS, PERMISSION_LABEL, isPermission } from "../../../../lib/permissions.ts";
import { DeviceDecisionButtons } from "./decision.tsx";

export const metadata: Metadata = { title: "Approve a sign-in" };

function normalise(code: string): string {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export default async function DevicePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;

  if (!supabaseConfig() && apiMode() === "live") {
    return (
      <div className="auth-card">
        <h1>Sign-in isn't set up here</h1>
        <p>
          Approving <code>windkeel login</code> needs you signed in to the console as yourself, and this console runs on a shared operator token.
          Ask whoever runs Windkeel to turn on sign-in, or use a token from Settings in <code>WINDKEEL_API_TOKEN</code> instead.
        </p>
      </div>
    );
  }

  if (!code) {
    return (
      <div className="auth-card">
        <h1>Approve a sign-in</h1>
        <p>Enter the code your terminal printed after <code>windkeel login</code>.</p>
        <form method="get" className="oq-stack">
          <div className="oq-field">
            <label className="oq-field__label" htmlFor="code">
              Code
            </label>
            <input id="code" name="code" className="oq-input oq-input--mono" placeholder="WDJB-MJHT" autoComplete="off" autoCapitalize="characters" required />
          </div>
          <button type="submit" className="oq-button oq-button--primary oq-button--lg">
            Continue
          </button>
        </form>
      </div>
    );
  }

  const userCode = normalise(code);
  const request = await getDeviceRequest(userCode);

  if (!request || request.state === "expired") {
    return (
      <div className="auth-card">
        <h1>That code isn't valid</h1>
        <p>
          <span className="oq-mono">{userCode}</span> doesn't match a sign-in waiting for approval. Codes expire after ten minutes — run{" "}
          <code>windkeel login</code> again for a new one.
        </p>
        <a className="oq-button oq-button--lg" href="/login/device">
          Enter a different code
        </a>
      </div>
    );
  }
  if (request.state !== "pending") {
    return (
      <div className="auth-card">
        <h1>Already {request.state}</h1>
        <p>This sign-in was already {request.state}. Nothing more to do here.</p>
      </div>
    );
  }

  const identity = await getIdentity();
  const held = new Set(identity.organizations.flatMap((o) => o.permissions));
  const requested = request.requestedPermissions.filter(isPermission);
  const granted = requested.filter((p) => held.has(p));
  const withheld = requested.filter((p) => !held.has(p));
  const admin = granted.some((p) => ADMIN_PERMISSIONS.has(p));
  return (
    <div className="auth-card">
      <h1>Approve a sign-in from your terminal?</h1>
      <p>
        <strong>{request.machineName}</strong> is asking for a token that acts as you. Check the code below matches the one in your terminal,
        character for character.
      </p>
      <div className="device-code" aria-label={`Code ${userCode.split("").join(" ")}`}>
        {request.userCode}
      </div>

      {admin ? (
        <Banner intent="warning" title="This asks for admin access">
          <p>
            With this token, the terminal could invite and remove members, create more tokens, and change which repositories your organization
            can reach. Approve only if you ran <code>windkeel login --admin</code> yourself, just now.
          </p>
        </Banner>
      ) : null}

      <div className="oq-stack">
        <strong>If you approve, it can:</strong>
        <ul className="device-grants">
          {granted.map((p) => (
            <li key={p} data-admin={ADMIN_PERMISSIONS.has(p)}>
              <span>{PERMISSION_LABEL[p].label}</span>
              <span>{PERMISSION_LABEL[p].detail}</span>
            </li>
          ))}
        </ul>
        {withheld.length ? (
          <p className="auth-fine" style={{ textAlign: "left" }}>
            It also asked for {withheld.map((p) => PERMISSION_LABEL[p].label.toLowerCase()).join(", ")} — your role doesn't include{" "}
            {withheld.length === 1 ? "that" : "those"}, so the token won't get {withheld.length === 1 ? "it" : "them"}.
          </p>
        ) : null}
        <p className="auth-fine" style={{ textAlign: "left" }}>
          Never more than your own role allows. Revoke it any time from Settings → Your tokens.
        </p>
      </div>

      <DeviceDecisionButtons userCode={request.userCode} admin={admin} />
      <p className="auth-fine">Didn't run windkeel login? Deny — someone may have sent you this link.</p>
    </div>
  );
}
