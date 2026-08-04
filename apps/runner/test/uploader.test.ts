import { describe, it, expect } from "vitest";
import { MessageUploader, redact } from "../src/uploader.js";

function mockClient(failures: Map<number, { status: number; body: any }> = new Map()) {
  const received: any[][] = [];
  return {
    received,
    async appendMessages(_id: string, _t: string, msgs: any[]) {
      const first = msgs[0]?.seq ?? -1;
      if (failures.has(first)) {
        const f = failures.get(first)!;
        failures.delete(first);
        const err: any = new Error("conflict");
        err.status = f.status;
        err.body = f.body;
        throw err;
      }
      received.push(msgs);
      return { last_seq: msgs[msgs.length - 1].seq };
    },
  };
}

describe("redact", () => {
  it("replaces secrets in content/input/output", () => {
    const m = redact(
      { type: "tool_use", tool: "Bash", input: { cmd: "curl -H Bearer atk_secret123" }, content: "token is atk_secret123" },
      ["atk_secret123"],
    );
    expect(m.content).toBe("token is ***");
    expect(JSON.stringify(m.input)).toContain("***");
    expect(JSON.stringify(m.input)).not.toContain("atk_secret123");
  });
});

describe("MessageUploader", () => {
  it("batches messages with continuous seq", async () => {
    const client = mockClient();
    const up = new MessageUploader(client as any, "t1", "tok", [], 10);
    up.push({ type: "text", content: "a" });
    up.push({ type: "text", content: "b" });
    await up.close();
    expect(client.received.flat().map((m) => m.seq)).toEqual([0, 1]);
  });

  it("resyncs from server last_seq on 409", async () => {
    const failures = new Map([[0, { status: 409, body: { last_seq: 0 } }]]);
    const client = mockClient(failures);
    const up = new MessageUploader(client as any, "t1", "tok", [], 10);
    up.push({ type: "text", content: "a" });
    up.push({ type: "text", content: "b" });
    await up.close();
    const sent = client.received.flat().map((m) => m.content);
    expect(sent).toEqual(["b"]);
  });
});
