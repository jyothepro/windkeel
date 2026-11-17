export function isSafeArtifactPath(path: string): boolean {
  return (
    !!path &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}
