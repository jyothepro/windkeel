import { execFile } from "node:child_process";

export const resolveRef = (ref, done) => execFile("git", ["rev-parse", ref], done);
