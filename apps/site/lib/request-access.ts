export const TEAM_SIZES = ["1-10", "11-50", "51-200", "201-1000", "1000+"] as const;
export type TeamSize = (typeof TEAM_SIZES)[number];

export const LIMITS = { email: 254, company: 120, agents: 500 } as const;

export type AccessRequest = {
  email: string;
  company: string;
  teamSize: TeamSize;
  agents: string;
};

export type FieldName = keyof AccessRequest;

export type ValidationResult =
  | { ok: true; value: AccessRequest }
  | { ok: false; spam: true }
  | { ok: false; spam: false; errors: Partial<Record<FieldName, string>> };

export const HONEYPOT_FIELD = "website";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

function isTeamSize(value: string): value is TeamSize {
  return (TEAM_SIZES as readonly string[]).includes(value);
}

export function validateAccessRequest(input: unknown): ValidationResult {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  if (text(record, HONEYPOT_FIELD) !== "") return { ok: false, spam: true };

  const email = text(record, "email");
  const company = text(record, "company");
  const teamSize = text(record, "teamSize");
  const agents = text(record, "agents");
  const errors: Partial<Record<FieldName, string>> = {};

  if (email === "") errors.email = "Enter your work email.";
  else if (email.length > LIMITS.email || !EMAIL.test(email)) errors.email = "Enter an email like name@company.com.";

  if (company === "") errors.company = "Enter your company or team name.";
  else if (company.length > LIMITS.company) errors.company = `Keep the company name under ${LIMITS.company} characters.`;

  if (!isTeamSize(teamSize)) errors.teamSize = "Choose your team size.";

  if (agents === "") errors.agents = "Tell us which coding agents you use, or write none.";
  else if (agents.length > LIMITS.agents) errors.agents = `Keep this under ${LIMITS.agents} characters.`;

  if (Object.keys(errors).length > 0 || !isTeamSize(teamSize)) return { ok: false, spam: false, errors };
  return { ok: true, value: { email: email.toLowerCase(), company, teamSize, agents } };
}
