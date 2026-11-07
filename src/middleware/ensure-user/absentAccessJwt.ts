import type { AppError } from "@/server/lib/errors";

// Distinguishes "this request has no Access JWT" from the other
// AUTH_CONFIG_MISSING cases (missing TEAM_DOMAIN / POLICY_AUD, bad audience
// or issuer, JWKS failures). Page routes still surface the setup error.
// /mcp turns only this reason into HTTP 401.
export const ABSENT_ACCESS_JWT_REASON = "missing_access_jwt";

export function isAbsentAccessJwtError(error: AppError): boolean {
  return (
    error.code === "AUTH_CONFIG_MISSING" &&
    error.details?.reason === ABSENT_ACCESS_JWT_REASON
  );
}
