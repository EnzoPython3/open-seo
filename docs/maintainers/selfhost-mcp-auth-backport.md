# Backport: /mcp Access HTTP status

This branch is `cursor/mcp-access-http-backport-b871`. It starts at `3632f408` (3 Sep 2026, package 0.1.7), which is also `cursor/selfhost-v017-baseline-b871`.

Do not merge this branch, or `cursor/selfhost-v017-baseline-b871`, into current `main`. That would replace months of later work with this historical tree. The pull request, if opened, uses the baseline branch as its base so the diff is only this fix. Merge it only into that baseline, and only when a deploy of this tree is separately approved. Pull request #1 on current `main` stays the newer-main reference and is not this deploy.

## What this changes

`POST /mcp` in `cloudflare_access` mode classifies expected Access failures as HTTP responses instead of an uncaught `AppError`.

- No Access JWT, or a JWT that fails verification: 401.
- A verified JWT that is not a human identity, including Cloudflare's published service-token shape: 403. No user row is written.
- Missing `TEAM_DOMAIN` or `POLICY_AUD`, a bad issuer or audience, and other unexpected errors still throw.

This does not accept service tokens or any other connector identity. Unsigned `CF-Access-Client-Id`, `CF-Access-Client-Secret`, and `Cf-Access-Authenticated-User-Email` headers are not credentials. It does not change Google OAuth, `GOOGLE_CLIENT_ID`, or consent. Migrations `0000`–`0044` are untouched.

## Rebuild comparison

`pnpm install --frozen-lockfile` and `pnpm exec vite build --mode selfhost` on `3632f408` (Node 22.23.4, pnpm 10.30.1, Vite 7.3.6) did not reproduce the deployed bytes.

- Deployed main module `assets/index-DPQHk8cf.js`: SHA-256 `45c627e124cda55a66df6ad3e9e317a04ac8c62a781fcc81bf32d3e4eac044d9`, 8586436 bytes.
- Rebuild main module `dist/server/assets/index-DMH1uxfU.js`: SHA-256 `5fe018ae6465a789617521b164cdd7a9fe513335fbd0c4271358f6aaf2e6eab9`, 8586436 bytes.
- The route manifest embeds the absolute build directory. The uploaded package used the path on the machine that built it. This rebuild used a different directory, so every content hash that depends on that manifest changed.
- After replacing that directory prefix and the Vite chunk hashes, all 159 deployed JavaScript modules matched the rebuild. The rebuild also emitted `app-7vvDIS-S.css`, which is not in the Worker module list.

That is a source-level match of the application bundle, not a byte-identical artifact. No `.env.selfhost` was used. Native dependency postinstall scripts were skipped by this environment and the build still completed.
