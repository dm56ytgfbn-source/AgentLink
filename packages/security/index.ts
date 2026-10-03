import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { LinkError } from "../protocol/index.js";
export function authorized(header: string | undefined, token: string) {
  const a = Buffer.from(header ?? ""),
    b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function resolveAllowed(
  input: string,
  roots: string[],
  create = false,
): Promise<string> {
  if (
    !path.isAbsolute(input) ||
    input.includes("\0") ||
    (process.platform === "win32" &&
      (input.slice(2).includes(":") || input.startsWith("\\\\")))
  )
    throw new LinkError("PATH_DENIED");
  const absolute = path.resolve(input);
  const rootPaths = await Promise.all(roots.map((r) => realpath(r)));
  const inside = (p: string) =>
    rootPaths.some((r) => {
      const rel = path.relative(r, p);
      return (
        rel === "" ||
        (!rel.startsWith(".." + path.sep) &&
          rel !== ".." &&
          !path.isAbsolute(rel))
      );
    });
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch (e) {
    if (!create || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // Reject dangling symlinks rather than following them during creation.
    try {
      await lstat(absolute);
      throw new LinkError("PATH_DENIED");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    resolved = path.join(
      await realpath(path.dirname(absolute)),
      path.basename(absolute),
    );
  }
  if (!inside(resolved)) throw new LinkError("PATH_DENIED");
  return resolved;
}
