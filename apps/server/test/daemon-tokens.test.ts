import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
});

describe("daemon tokens", () => {
  it("list / heartbeat / revoke → 401 / double revoke → 409 / unknown → 404", async () => {
    const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: { label: "ci" } });
    expect(tk.statusCode).toBe(201);
    const { id, token } = tk.json();

    const list = await app.inject({ method: "GET", url: "/api/daemon-tokens" });
    expect(list.statusCode).toBe(200);
    const row = list.json().find((r: any) => r.id === id);
    expect(row).toBeTruthy();
    expect(row.label).toBe("ci");
    expect(row.revoked_at).toBeNull();
    expect(row.created_at).toBeTruthy();
    // 列表不得泄露哈希/明文
    expect(row.token_hash).toBeUndefined();
    expect(row.token).toBeUndefined();

    const hb = () =>
      app.inject({
        method: "POST", url: "/api/daemon/heartbeat",
        headers: { authorization: `Bearer ${token}` },
        payload: { daemon_id: "d1" },
      });
    expect((await hb()).statusCode).toBe(200);

    const rv = await app.inject({ method: "POST", url: `/api/daemon-tokens/${id}/revoke` });
    expect(rv.statusCode).toBe(200);

    const listed = await app.inject({ method: "GET", url: "/api/daemon-tokens" });
    expect(listed.json().find((r: any) => r.id === id).revoked_at).toBeTruthy();

    expect((await hb()).statusCode).toBe(401);

    const again = await app.inject({ method: "POST", url: `/api/daemon-tokens/${id}/revoke` });
    expect(again.statusCode).toBe(409);

    const missing = await app.inject({ method: "POST", url: "/api/daemon-tokens/does-not-exist/revoke" });
    expect(missing.statusCode).toBe(404);
  });
});
