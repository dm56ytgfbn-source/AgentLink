export type ErrorCode =
  | "UNAUTHORIZED"
  | "BUSY"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "PROCESS_FAILED"
  | "FILE_LOCKED"
  | "PATH_DENIED"
  | "NODE_OFFLINE"
  | "INVALID_REQUEST"
  | "ALREADY_EXISTS"
  | "DIRECTORY_NOT_EMPTY"
  | "CONFLICT"
  | "INTERNAL_ERROR";
export class LinkError extends Error {
  constructor(
    public code: ErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}
export type Action =
  | "tasks.submit"
  | "tasks.get"
  | "tasks.logs"
  | "tasks.cancel"
  | "shell.run"
  | "files.list"
  | "files.read"
  | "files.write"
  | "files.stat"
  | "files.mkdir"
  | "files.rename"
  | "files.delete"
  | "files.trash"
  | "files.upload_residue"
  | "files.cleanup_uploads"
  | "files.read_chunk"
  | "files.write_chunk"
  | "files.truncate"
  | "files.commit"
  | "files.replace"
  | "apps.launch"
  | "screen.capture"
  | "window.list"
  | "window.capture"
  | "window.focus"
  | "window.input";
export interface Request {
  id: string;
  type: "request";
  action: Action;
  payload: Record<string, unknown>;
  timestamp: number;
}
export interface Response {
  id: string;
  type: "response";
  ok: boolean;
  result: unknown;
  error: { code: ErrorCode; message: string } | null;
}
export interface NodeInfo {
  protocol_version?: number;
  features?: string[];
  device_id: string;
  name: string;
  os: string;
  hostname: string;
  architecture: string;
  default_cwd?: string;
  capabilities: string[];
}
export function str(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new LinkError("INVALID_REQUEST");
  return value;
}
export function parseRequest(value: unknown): Request {
  const r = value as Request;
  if (
    !r ||
    r.type !== "request" ||
    typeof r.id !== "string" ||
    r.id.length > 128 ||
    !Number.isFinite(r.timestamp) ||
    !r.payload ||
    Array.isArray(r.payload) ||
    typeof r.payload !== "object" ||
    ![
      "tasks.submit",
      "tasks.get",
      "tasks.logs",
      "tasks.cancel",
      "shell.run",
      "files.list",
      "files.read",
      "files.write",
      "files.stat",
      "files.mkdir",
      "files.rename",
      "files.delete",
      "files.trash",
      "files.upload_residue",
      "files.cleanup_uploads",
      "files.read_chunk",
      "files.write_chunk",
      "files.truncate",
      "files.commit",
      "files.replace",
      "apps.launch",
      "screen.capture",
      "window.list",
      "window.capture",
      "window.focus",
      "window.input",
    ].includes(r.action)
  )
    throw new LinkError("INVALID_REQUEST");
  return r;
}
export function normalizeError(e: unknown): LinkError {
  if (e instanceof LinkError) return e;
  const code = (e as NodeJS.ErrnoException)?.code;
  return new LinkError(
    code === "EEXIST" ? "ALREADY_EXISTS" : code === "ENOTEMPTY" ? "DIRECTORY_NOT_EMPTY" : code === "ENOENT"
      ? "NOT_FOUND"
      : code === "EACCES" || code === "EPERM"
        ? "FORBIDDEN"
        : code === "EBUSY"
          ? "FILE_LOCKED"
          : "INTERNAL_ERROR",
  );
}
