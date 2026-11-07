# Self-hosted Access authentication for /mcp

This note is for the `open-seo-selfhost` deployment. It records why the branch that maps expected Access rejections to HTTP responses must not be deployed until the running Worker is identified. It does not change Cloudflare, Google, secrets, or Access policies.

## Do not deploy yet

Fork `main` is not the production Worker. Deploying it would ship a large application upgrade and would ask D1 to apply every sqlite migration after `0044_outstanding_sage.sql`. Neither step is part of the auth fix, and neither has been validated against the running script.

Leave the five-minute and daily crons enabled. This change does not modify scheduled handlers.

## What the running Worker appears to be

Read-only evidence, not a commit match:

- Workers were uploaded on 4 Sep 2026. The active Worker version id is `7313b485-94f8-43e8-8096-d7b98c7c3c23`. The audit Worker version id is `8ca9502f-d594-451b-96c1-6c806db91e53`. Neither id appears in this git history. This repository has no tags that pin that upload.
- The deployed D1 database has 45 migrations, and the last one is `0044_outstanding_sage.sql`.
- That migration was added in `ea162a43` (26 Aug 2026). The next migration, which became `0045`, was added in `48125763` (11 Sep 2026). A database still ending at `0044` was migrated from a tree in that window.
- `3632f408` (3 Sep 2026) is the last commit before 5 Sep 2026, and that tree still contains only migrations `0000` through `0044`. The upload date falls in the same window. That does not prove the uploaded script is `3632f408`. The script may be any commit with that schema, or a build that was not committed.
- Fork `main` (`46b815be`, 6 Nov 2026) has sqlite migrations through `0068_guest_claimed_by.sql` (69 files). The gap is migrations `0045` through `0068`, plus every application change after the unknown upload.

Before any deploy, compare the running script for version `7313b485-94f8-43e8-8096-d7b98c7c3c23` with the commit you intend to ship. Review migrations `0045` through `0068` separately. Do not reset `main` to the September tree.

The auth failure itself is on both sides of the gap. Before this change, `3632f408` and fork `main` both threw `AppError: UNAUTHENTICATED` from `resolveCloudflareAccessContext` when a verified JWT had no usable `sub` or `email`, and the same code covered an invalid JWT. `handleSelfHostedOpenSeoMcpRequest` did not catch it, so Workers recorded `scriptThrewException` and HTTP 500. Requests carried Access service-token header names. The JWTs were not decoded, so a service-token payload is a documented explanation, not a confirmed one. Scheduled invocations in the measured window succeeded and had no candidates.

## How /mcp treats Access

`AUTH_MODE=cloudflare_access` still requires a verified `Cf-Access-Jwt-Assertion`. The signature, issuer (`TEAM_DOMAIN`), and audience (`POLICY_AUD`) checks are unchanged. These headers are not an identity and are not accepted on their own:

- `CF-Access-Client-Id`
- `CF-Access-Client-Secret`
- `Cf-Access-Authenticated-User-Email`

After a JWT verifies:

- A non-empty `sub` and `email` is a human identity. OpenSEO provisions that person as before.
- Cloudflare's published service-token payload sets `common_name` to the client id and `sub` to an empty string, and it has no `email`. That identity is refused with HTTP 403. No user row is written. `common_name` is never used as a user id.
- Any other verified payload without both human claims is also refused with HTTP 403. It is not provisioned.
- A missing JWT is HTTP 401. A JWT that fails verification (bad signature, expired) is HTTP 401.
- Missing `TEAM_DOMAIN` or `POLICY_AUD`, and an issuer or audience mismatch, still throw. Those stay Worker failures.
- A database error while provisioning a human still throws.

401 and 403 are ordinary responses, not uncaught exceptions. This mode does not send a `WWW-Authenticate: Bearer` challenge. Worker OAuth is not mounted for `cloudflare_access`; Access Managed OAuth, when used, challenges at the edge.

A verified service token that Access fills with a human-shaped `sub` and `email` would be treated as that human. The published service-token shape does not look like that, and the live tokens were not decoded.

## Google Search Console and Analytics

Not applied here. No secret values were read or written. `GOOGLE_CLIENT_ID` was empty in production at the time of the read-only check. Bindings named `GOOGLE_CLIENT_SECRET` and `BETTER_AUTH_SECRET` exist; their values were not verified. Do not paste any of them into git, a PR, or this note.

Search Console and Analytics use OpenSEO's own Google OAuth client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). Tokens are encrypted with `BETTER_AUTH_SECRET` (at least 32 characters). A Google reporting service account is not read by this flow. Connecting requires a person.

In the Google Cloud project that will own the OAuth client:

1. Enable the Google Search Console API, the Google Analytics Admin API, and the Google Analytics Data API.
2. Configure the OAuth consent screen. While the app is in Testing, add the Google account that will connect as a test user. Publish the app when that account can connect; a Testing app expires refresh tokens after 7 days. The consent screen can stay unverified for personal use; Google shows a warning the person can click through.
3. Create a Web application OAuth client. Authorized redirect URIs, exact, no trailing slash:

   `https://open-seo-selfhost.enzo-snyman2.workers.dev/api/gsc/oauth/callback`

   `https://open-seo-selfhost.enzo-snyman2.workers.dev/api/ga4/oauth/callback`

4. Set `GOOGLE_CLIENT_ID` to that client id. Set `GOOGLE_CLIENT_SECRET` if it is not already the matching secret. Leave an existing `BETTER_AUTH_SECRET` in place if it is already at least 32 characters; it encrypts stored grants. Generate one only if it is missing or shorter than 32 characters, and do that before the first successful connect.

Scopes the app requests, all read-only for the data APIs:

- Search Console: `openid`, `email`, `profile`, `https://www.googleapis.com/auth/webmasters.readonly`
- Analytics: `openid`, `email`, `profile`, `https://www.googleapis.com/auth/analytics.readonly`

The two grants are separate. The same OAuth client can serve both.

Human steps after a future deploy that actually contains this code and the secrets:

1. Sign in through Cloudflare Access as a person the Access policy allows. A service token cannot complete consent.
2. In the project, connect Search Console and approve the read-only consent with a Google account that can access `sc-domain:amaphupho.co.za`. Choose that property.
3. Connect Google Analytics with a Google account that can access property `539470043`. Choose that property.
4. Read one Search Console report and one Analytics report for the project.

## Safe checks before a deploy

Do these on a non-production build of the commit you intend to ship, after the script diff and the migration review. Do not point them at the production Worker as part of preparing this fix.

- `POST /mcp` with no `Cf-Access-Jwt-Assertion` returns 401. The invocation is not `scriptThrewException`. Service-token headers without a JWT do not get in.
- `POST /mcp` with a JWT that fails verification returns 401, also not an exception.
- A service token that Access accepts returns 403, and it does not create a user.
- A human the Access policy allows can open the app and call `/mcp`.
- Crons are still enabled.
- Google consent uses the human session and the two callback URLs above, then the two properties above.
