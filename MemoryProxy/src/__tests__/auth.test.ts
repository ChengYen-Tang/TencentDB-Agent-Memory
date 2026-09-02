import { afterEach, describe, expect, it, vi } from "vitest";
import { initAuth, verifyUserKey } from "../auth.js";

afterEach(() => {
  initAuth({ enabled: false, url: "", timeoutMs: 5000 });
  vi.unstubAllGlobals();
});

describe("MemoryProxy auth client", () => {
  it("uses auth.serviceToken for the MemoryCore Gateway bearer gate", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { valid: true, user: { user_id: "usr-1" } },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    initAuth({
      enabled: true,
      url: "http://memory-core:8420",
      serviceToken: "gateway-secret",
      timeoutMs: 5000,
    });

    await expect(verifyUserKey("sk-mem-user", "default")).resolves.toEqual({
      userId: "usr-1",
      rejected: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://memory-core:8420/v3/meta/auth/verify",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer gateway-secret",
          "x-tdai-service-id": "default",
        }),
      }),
    );
  });
});
