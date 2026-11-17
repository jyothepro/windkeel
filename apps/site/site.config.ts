export const site = {
  name: "Windkeel",
  url: "https://windkeel.dev",
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "https://app.windkeel.dev",
  docsUrl: "https://app.windkeel.dev/docs",
  githubUrl: "https://github.com/jyothepro/windkeel",
  statusUrl: "TODO",
  contactEmail: "TODO",
  description:
    "Windkeel turns a described piece of engineering work into a verified draft pull request. A maker agent writes the change; an independent verifier, in a fresh sandbox, decides whether it passes.",
} as const;

export function isTodo(value: string): boolean {
  return value === "TODO";
}

export function linkOrTodo(value: string): string | null {
  return isTodo(value) ? null : value;
}
