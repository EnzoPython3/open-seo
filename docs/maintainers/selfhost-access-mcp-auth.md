# Self-hosted Access authentication for /mcp

This note is for the `open-seo-selfhost` deployment. It records why this pull request must not be deployed, which tree the running Worker matches, and why the auth fix should be backported instead of upgrading in place. It does not change Cloudflare, Google, secrets, or Access policies.

## Do not deploy this pull request

This branch is fork `main` plus the auth fix. Fork `main` (`46b815be`, 6 Nov 2026) is not the Worker uploaded on 4 Sep 2026. Deploying it would upgrade the app from 0.1.7 to 0.1.26 and would ask D1 to apply migrations `0045` through `0068`. The auth fix does not need those migrations. Leave the five-minute and daily crons enabled. This change does not modify scheduled handlers. Do not reset `main`.

## Version match

The read-only package for Worker version `7313b485-94f8-43e8-8096-d7b98c7c3c23` was created at `2026-09-04T16:54:13Z`. It has handlers `fetch` and `scheduled`, and named handlers `OnboardingChatAgent`, `SamChatAgent`, and `RankCheckWorkflow`. The main module is `assets/index-DPQHk8cf.js`. There is no source map. The version id is not a git commit, and this repository has no tag for the upload.

That package agrees with commit `3632f408` (3 Sep 2026, package `0.1.7`) on the points below. It is the candidate base. It is not a byte-for-byte proof of the script.

- At that upload time, `3632f408` was the tip of this history. The next commit is `dd046957` on 11 Sep 2026.
- `src/`, `drizzle/`, and `wrangler.jsonc` are identical from `ac9ee482` (28 Aug 2026) through `3632f408`. The only differences are marketing blog files, which are not in the Worker. A Worker build of `ac9ee482` and of `3632f408` would compile the same application sources.
- The bundle still exports `OnboardingChatAgent`. `361d488d` (11 Sep 2026) removes that export.
- Bundled strings from the GA4 date-range fix (`ad2d28ea`) and from the revert of the audit 429 retry (`ac9ee482`) are present. Strings added by the site-audit strategy library (`dd046957`) and by the scratchpad `page_mirror` change (`78a7e283`) are absent.
- `wrangler.jsonc` at `3632f408` has `compatibility_date` `2025-09-02` and flags `nodejs_compat` and `global_fetch_strictly_public`, matching the running runtime. Crons there are `*/5 * * * *` and `17 3 * * *`.
- The deployed module throws `AppError: UNAUTHENTICATED` when a verified JWT has no usable `sub` or `email` (`index-DPQHk8cf.js` around the `resolveCloudflareAccessContext` check) and `handleSelfHostedOpenSeoMcpRequest` does not catch it. That is the same control flow as `3632f408`. This branch's later transport behavior (report user agent, MCP apps, guest claim) is not in that module.
- D1 has applied `0000_fantastic_vanisher.sql` through `0044_outstanding_sage.sql` and no later name. The live tables still have `audit_pages.heading_order_json`, `images_json`, and `hreflang_tags_json`. `rank_tracking_keywords` has no `match_case` column. There is no `reports`, `guest_accounts`, `ai_trackers`, or `local_rank_trackers` table. The SQL bytes of `0000`–`0044` are unchanged from `3632f408` to current `main`; only the directory moved to `drizzle/sqlite/`.

What would still prove the script bytes: rebuild `3632f408` with its lockfile and compare the emitted main module with `assets/index-DPQHk8cf.js`. No further production fetch is required for that. Do not treat this candidate as an exact match until that hash agrees.

## Migrations 0045–0068

Do not apply these to fix the `/mcp` 500s. Current `main` will not run correctly on the live 0044 schema, because it queries tables and columns these migrations add. D1 has no down migrations.

Most of `0045`–`0068` are additive (`CREATE TABLE` or a nullable column): `0046`–`0049`, `0051`–`0054`, `0056`–`0058`, `0060`, `0061`, `0063`–`0065`, `0067`, `0068`. `0045` adds `rank_tracking_keywords.match_case` with a default. Rolling the Worker back after an additive migration usually still works, because the old code does not select the new columns. Rolling the Worker back after a column drop does not.

Three migrations are not safe to apply casually:

- `0050_famous_crystal.sql` deletes extra `account` rows for Search Console and Analytics grants, then adds a unique index. Deleted rows do not come back without a backup.
- `0055_chief_centennial.sql` drops `audit_pages.heading_order_json`, `images_json`, and `hreflang_tags_json`. The live table still has all three. The 0.1.7 Worker reads them. Applying `0055` and then rolling the Worker back breaks those reads. Restore the database from a backup taken beforehand.
- `0059_thankful_aaron_stack.sql` replaces the rank-tracking uniqueness indexes so language is part of the key. It can fail if existing rows would collide, and the old indexes are the ones production still has.

`0062` rewrites API-key metadata. `0066` renumbers guest-account slots. Both are empty of effect until those features have rows. Production has neither the later guest tables nor a reason to run them for this fix.

A full upgrade also changes bindings. The running Worker still has the `ONBOARDING_CHAT` durable object. Current `main` removes that binding and adds AI Visibility, local rank, Browser Run, and `CONTEXT_API_KEY`. That is a separate deploy, not a patch.

## Recommendation

Backport only the auth rejection onto `3632f408`. Keep D1 at `0044`. Do not deploy this pull request, and do not take the full upgrade in order to fix these 500s.

The backport is small: when `resolveCloudflareAccessContext` is missing a JWT, or verification fails, `/mcp` returns 401; when the JWT verifies and is not a human (including the published service-token shape), it returns 403 and does not create a user. Configuration failures and database errors still throw. The report-route 403 on this branch should not be part of the backport. Production has no `reports` table.

Ship that backport only after a non-production build:

- Confirm the built main module against `index-DPQHk8cf.js` before changing the patch, or accept that the base is a source match and not a proven byte match.
- `POST /mcp` with no JWT returns 401 and is not `scriptThrewException`. Service-token headers without a JWT do not get in.
- `POST /mcp` with a JWT that fails verification returns 401.
- A service token Access has already authenticated returns 403 and creates no user.
- A human the Access policy allows can open the app and call `/mcp`.
- Crons stay `*/5 * * * *` and `17 3 * * *`.
- `d1_migrations` still ends at `0044_outstanding_sage.sql`.

Take a D1 backup before any later decision to apply `0045`–`0068`, and treat `0050` and `0055` as the point of no return.

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

Use the non-production checks in the recommendation above. Do not point them at the production Worker while preparing this fix. Google consent, after a later deploy that actually contains the client, uses the human Access session, the two callback URLs above, and then `sc-domain:amaphupho.co.za` and GA4 property `539470043`.
