import { exec } from "node:child_process";

// Seeded defect: the caller-supplied ref is interpolated into a shell command line.
export const resolveRef = (ref, done) => exec(`git rev-parse ${ref}`, done);
