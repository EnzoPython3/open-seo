import { beforeEach, describe, expect, it, vi } from "vitest";
import { ABSENT_ACCESS_JWT_REASON } from "@/middleware/ensure-user/absentAccessJwt";
import { AppError } from "@/server/lib/errors";
import { handleSelfHostedOpenSeoMcpRequest } from "@/server/mcp/transport";

const resolveCloudflareAccessContext = vi.hoisted(() => vi.fn());
const createOpenSeoMcpServer = vi.hoisted(() => vi.fn());

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/lib/auth", () => ({
  getHostedBaseUrl: () => "https://open-seo.test",
}));
vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: { getMembership: vi.fn() },
}));
vi.mock("@/server/auth/repositories/GuestAccountRepository", () => ({
  GuestAccountRepository: { findClaimingUser: vi.fn() },
}));
vi.mock("@/middleware/ensure-user/cloudflareAccess", () => ({
  resolveCloudflareAccessContext,
}));
vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveLocalNoAuthContext: vi.fn(),
}));
vi.mock("@/server/mcp/server", () => ({
  createOpenSeoMcpServer,
}));
vi.mock("agents/mcp/server", () => ({
  createMcpHandler: vi.fn(
    () => async () => new Response(null, { status: 202 }),
  ),
}));

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

function createMcpRequest(headers?: Record<string, string>) {
  return new Request("https://open-seo.test/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("self-hosted MCP access rejections", () => {
  beforeEach(() => {
    resolveCloudflareAccessContext.mockResolvedValue({
      userId: "cloudflare-user",
      userEmail: "person@example.com",
      organizationId: "delegated-cloudflare-user",
    });
  });

  it("answers a missing Access JWT with 401, even when service-token headers are present", async () => {
    resolveCloudflareAccessContext.mockRejectedValue(
      new AppError("AUTH_CONFIG_MISSING", "No Cloudflare Access token", {
        reason: ABSENT_ACCESS_JWT_REASON,
      }),
    );

    const response = await handleSelfHostedOpenSeoMcpRequest(
      createMcpRequest({
        "CF-Access-Client-Id": "service-token.access",
        "CF-Access-Client-Secret": "not-a-secret",
      }),
      "cloudflare_access",
      {},
      ctx,
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Authentication required");
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
    expect(createOpenSeoMcpServer).not.toHaveBeenCalled();
  });

  it("answers an invalid Access credential with 401", async () => {
    resolveCloudflareAccessContext.mockRejectedValue(
      new AppError("UNAUTHENTICATED"),
    );

    const response = await handleSelfHostedOpenSeoMcpRequest(
      createMcpRequest({ "cf-access-jwt-assertion": "not-a-jwt" }),
      "cloudflare_access",
      {},
      ctx,
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Authentication required");
    expect(createOpenSeoMcpServer).not.toHaveBeenCalled();
  });

  it("answers a forbidden Access identity with 403", async () => {
    resolveCloudflareAccessContext.mockRejectedValue(
      new AppError(
        "FORBIDDEN",
        "Cloudflare Access authenticated a service token. OpenSEO only accepts a human Access identity.",
      ),
    );

    const response = await handleSelfHostedOpenSeoMcpRequest(
      createMcpRequest({ "cf-access-jwt-assertion": "verified-service-token" }),
      "cloudflare_access",
      {},
      ctx,
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("service token");
    expect(createOpenSeoMcpServer).not.toHaveBeenCalled();
  });

  it("leaves an Access configuration failure as a server error when a JWT is present", async () => {
    resolveCloudflareAccessContext.mockRejectedValue(
      new AppError(
        "AUTH_CONFIG_MISSING",
        "Cloudflare Access token rejected: audience mismatch.",
      ),
    );

    await expect(
      handleSelfHostedOpenSeoMcpRequest(
        createMcpRequest({ "cf-access-jwt-assertion": "wrong-audience" }),
        "cloudflare_access",
        {},
        ctx,
      ),
    ).rejects.toMatchObject({ code: "AUTH_CONFIG_MISSING" });
    expect(createOpenSeoMcpServer).not.toHaveBeenCalled();
  });

  it("leaves an unexpected resolver failure as a server error", async () => {
    resolveCloudflareAccessContext.mockRejectedValue(
      new Error("d1 unavailable"),
    );

    await expect(
      handleSelfHostedOpenSeoMcpRequest(
        createMcpRequest({ "cf-access-jwt-assertion": "verified-human" }),
        "cloudflare_access",
        {},
        ctx,
      ),
    ).rejects.toThrow("d1 unavailable");
    expect(createOpenSeoMcpServer).not.toHaveBeenCalled();
  });
});
