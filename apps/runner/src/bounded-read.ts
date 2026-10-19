import fs from "node:fs";

export type BoundedRead =
  | { ok: true; text: string }
  | { ok: false; reason: "missing" | "too_large" | "unreadable" };

/** 先按字节上限读取，超过上限时不把全文读进内存。 */
export function readBoundedUtf8(filePath: string, maxBytes: number): BoundedRead {
  let fd: number;
  try { fd = fs.openSync(filePath, "r"); }
  catch (error: any) {
    if (error?.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "unreadable" };
  }
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    const n = fs.readSync(fd, buf, 0, maxBytes + 1, 0);
    if (n > maxBytes) return { ok: false, reason: "too_large" };
    return { ok: true, text: buf.subarray(0, n).toString("utf8") };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    fs.closeSync(fd);
  }
}
