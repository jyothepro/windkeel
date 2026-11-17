export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/runs";
  if (/[\u0000-\u001f]/.test(next)) return "/runs";
  return next;
}

export function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/home" || pathname === "/pricing" || pathname.startsWith("/auth/") || pathname === "/not-a-member" || pathname === "/docs" || pathname.startsWith("/docs/");
}

export function selfServeSignupOn(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env["WINDKEEL_SELF_SERVE_SIGNUP"] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "invite";
}

export function notAMemberPath(env: Record<string, string | undefined> = process.env): "/welcome" | "/not-a-member" {
  return selfServeSignupOn(env) ? "/welcome" : "/not-a-member";
}
