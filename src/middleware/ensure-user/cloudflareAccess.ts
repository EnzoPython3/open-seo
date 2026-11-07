import { env } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { AppError } from "@/server/lib/errors";
import { validateTeamDomain } from "@/shared/selfhost-checks";
import { ABSENT_ACCESS_JWT_REASON } from "./absentAccessJwt";
import { classifyAccessVerificationError } from "./accessTokenErrors";
import { resolveSharedWorkspaceContext } from "./delegated";
import type { EnsuredUserContext } from "./types";

const jwksByTeamDomain = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

function getJwks(teamDomain: string) {
  const existing = jwksByTeamDomain.get(teamDomain);
  if (existing) {
    return existing;
  }

  const jwks = createRemoteJWKSet(
    new URL(`${teamDomain}/cdn-cgi/access/certs`),
  );

  jwksByTeamDomain.set(teamDomain, jwks);

  return jwks;
}

// A verified Access JWT is a person only when it carries both claims. Headers
// are not consulted: CF-Access-Client-Id, CF-Access-Client-Secret, and
// Cf-Access-Authenticated-User-Email are unsigned and must not admit anyone.
// Cloudflare's published service-token payload sets common_name to the client
// id and sub to an empty string, with no email. Live tokens were not decoded;
// any verified payload that lacks a usable sub or email is refused the same
// way and is not written into the user table.
function rejectionForVerifiedAccessIdentity(payload: JWTPayload): AppError {
  const commonName = payload.common_name;
  const sub = payload.sub;
  const serviceToken =
    typeof commonName === "string" &&
    commonName.length > 0 &&
    (typeof sub !== "string" || sub.length === 0);

  if (serviceToken) {
    return new AppError(
      "FORBIDDEN",
      "Cloudflare Access authenticated a service token. OpenSEO only accepts a human Access identity.",
    );
  }

  return new AppError(
    "FORBIDDEN",
    "This Cloudflare Access identity is not allowed to use OpenSEO.",
  );
}

function getValidatedTeamDomain(teamDomain: string) {
  const result = validateTeamDomain(teamDomain);

  if (!result.ok) {
    throw new AppError("AUTH_CONFIG_MISSING", result.message);
  }

  return result.origin;
}

export async function resolveCloudflareAccessContext(
  headers: Headers,
): Promise<EnsuredUserContext> {
  const teamDomain = env.TEAM_DOMAIN
    ? getValidatedTeamDomain(env.TEAM_DOMAIN)
    : null;
  const policyAud = env.POLICY_AUD?.trim() || null;

  if (!teamDomain || !policyAud) {
    const missing = [
      teamDomain ? null : "TEAM_DOMAIN",
      policyAud ? null : "POLICY_AUD",
    ]
      .filter(Boolean)
      .join(" and ");
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      `Missing Cloudflare Access configuration: set ${missing} on the deployment. See docs/SELF_HOSTING_CLOUDFLARE.md.`,
    );
  }

  const token = headers.get("cf-access-jwt-assertion");

  if (!token) {
    // With Access enabled in front of the deployment, browser requests carry
    // this header — its absence means Access is not actually protecting the
    // route, which is a setup problem, not a signed-out user. The reason lets
    // /mcp answer 401 without treating a missing TEAM_DOMAIN or a bad
    // audience as a client auth failure.
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      "No Cloudflare Access token on the request. Cloudflare Access is not enabled in front of this deployment — add an Access application covering this hostname in Zero Trust, or set AUTH_MODE=local_noauth if you intend to run without auth on a private network.",
      { reason: ABSENT_ACCESS_JWT_REASON },
    );
  }

  // Only the token verification itself is classified — anything thrown past
  // this block (user resolution, DB access) is an app fault, and classifying
  // it here would mislabel a DB outage as an auth-config problem.
  let payload: JWTPayload;
  try {
    const jwks = getJwks(teamDomain);
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience: policyAud,
    }));
  } catch (error) {
    // The classified AppError carries operator guidance; log the raw jose
    // error too, since it is the only place the underlying cause survives.
    console.error("Cloudflare Access token verification failed:", error);

    throw classifyAccessVerificationError(error);
  }

  const userId = typeof payload.sub === "string" ? payload.sub : null;
  const userEmail = typeof payload.email === "string" ? payload.email : null;

  if (!userId || !userEmail) {
    throw rejectionForVerifiedAccessIdentity(payload);
  }

  return resolveSharedWorkspaceContext(userId, userEmail);
}
