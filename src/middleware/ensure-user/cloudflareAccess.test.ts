import {
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyResult,
  type ResolvedKey,
} from "jose";
import type * as JoseModule from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import { ABSENT_ACCESS_JWT_REASON } from "./absentAccessJwt";
import { resolveCloudflareAccessContext } from "./cloudflareAccess";
import { resolveSharedWorkspaceContext } from "./delegated";

vi.mock("cloudflare:workers", () => ({
  env: {
    TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    POLICY_AUD: "aud-tag",
  },
}));

vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof JoseModule>();
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => ({})),
    jwtVerify: vi.fn(),
  };
});

vi.mock("./delegated", () => ({
  resolveSharedWorkspaceContext: vi.fn(),
}));

const humanContext = {
  userId: "user-1",
  userEmail: "person@example.com",
  emailVerified: true,
  organizationId: "shared-workspace",
  role: "owner",
};

function headers(extra?: Record<string, string>) {
  return new Headers(extra);
}

function verified(payload: JWTPayload) {
  const result: JWTVerifyResult & ResolvedKey = {
    payload,
    protectedHeader: { alg: "RS256" },
    key: new Uint8Array(),
  };
  vi.mocked(jwtVerify).mockResolvedValue(result);
}

function thrownAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  throw error;
}

describe("resolveCloudflareAccessContext", () => {
  beforeEach(() => {
    vi.mocked(jwtVerify).mockRejectedValue(
      new joseErrors.JWSSignatureVerificationFailed(),
    );
    vi.mocked(resolveSharedWorkspaceContext).mockResolvedValue(humanContext);
  });

  it("rejects a request with no Access JWT, including service-token headers", async () => {
    const error = await resolveCloudflareAccessContext(
      headers({
        "CF-Access-Client-Id": "service-token.access",
        "CF-Access-Client-Secret": "not-a-secret",
        "Cf-Access-Authenticated-User-Email": "attacker@example.com",
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "AUTH_CONFIG_MISSING",
      details: { reason: ABSENT_ACCESS_JWT_REASON },
    });
    expect(jwtVerify).not.toHaveBeenCalled();
    expect(resolveSharedWorkspaceContext).not.toHaveBeenCalled();
  });

  it("rejects an invalid Access JWT without provisioning a user", async () => {
    const error = await resolveCloudflareAccessContext(
      headers({ "cf-access-jwt-assertion": "not-a-jwt" }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(jwtVerify).toHaveBeenCalledWith("not-a-jwt", expect.anything(), {
      issuer: "https://team.cloudflareaccess.com",
      audience: "aud-tag",
    });
    expect(resolveSharedWorkspaceContext).not.toHaveBeenCalled();
  });

  it("refuses a verified service token instead of admitting it", async () => {
    verified({
      sub: "",
      common_name: "service-token.access",
    });

    const error = await resolveCloudflareAccessContext(
      headers({
        "cf-access-jwt-assertion": "verified-service-token",
        "CF-Access-Client-Id": "service-token.access",
        "Cf-Access-Authenticated-User-Email": "attacker@example.com",
      }),
    ).catch((caught: unknown) => caught);

    const appError = thrownAppError(error);
    expect(appError.code).toBe("FORBIDDEN");
    expect(appError.message).toContain("service token");
    expect(appError.message).not.toContain("service-token.access");
    expect(appError.message).not.toContain("attacker@example.com");
    expect(resolveSharedWorkspaceContext).not.toHaveBeenCalled();
  });

  it("refuses a verified token that is not a human identity", async () => {
    verified({ sub: "user-1" });

    const error = await resolveCloudflareAccessContext(
      headers({ "cf-access-jwt-assertion": "verified-without-email" }),
    ).catch((caught: unknown) => caught);

    const appError = thrownAppError(error);
    expect(appError.code).toBe("FORBIDDEN");
    expect(appError.message).not.toContain("service token");
    expect(resolveSharedWorkspaceContext).not.toHaveBeenCalled();
  });

  it("admits a verified human even when service-token headers are also present", async () => {
    verified({
      sub: "user-1",
      email: "person@example.com",
      common_name: "also-present.access",
    });

    const context = await resolveCloudflareAccessContext(
      headers({
        "cf-access-jwt-assertion": "verified-human",
        "CF-Access-Client-Id": "service-token.access",
        "Cf-Access-Authenticated-User-Email": "attacker@example.com",
      }),
    );

    expect(context).toEqual(humanContext);
    expect(resolveSharedWorkspaceContext).toHaveBeenCalledWith(
      "user-1",
      "person@example.com",
    );
  });

  it("lets a workspace failure escape as itself", async () => {
    verified({ sub: "user-1", email: "person@example.com" });
    vi.mocked(resolveSharedWorkspaceContext).mockRejectedValue(
      new Error("d1 unavailable"),
    );

    const error = await resolveCloudflareAccessContext(
      headers({ "cf-access-jwt-assertion": "verified-human" }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError);
    expect(error).toMatchObject({ message: "d1 unavailable" });
  });
});
