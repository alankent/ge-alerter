# ge-alerter

npm workspaces monorepo: `server/` (Express + MCP SDK + Firebase Admin, deployed to Cloud Run) and `web/` (Next.js static
export PWA on Firebase Hosting). See `README.md` for setup and `docs/ARCHITECTURE.md` for design.

Commands (run from the repo root):

- `npm install`
- `npm test` — server tests (vitest), run the OAuth + MCP flows against in-memory stores
- `npm run typecheck`, `npm run build`
- `npm run dev:server` with `STORE=memory` for a Firebase-free server

Conventions:

- Server code uses ESM with `.js` import suffixes; keep storage/push/identity behind the interfaces in
  `server/src/store/types.ts` so tests stay Firebase-free.
- `web/public/sw.js` and `web/lib/notificationDisplay.ts` build notifications the same way; change both together.
- Do not add always-on infrastructure; the design goal is zero cost while idle.

Deploying (cloud sessions):

- Credentials come from environment variables `GCP_PROJECT_ID` and `GCP_SA_KEY` (service account JSON) set in the
  Claude Code environment settings. Never write them to a file in the repo, print them, or commit them.
- Run `./scripts/bootstrap.sh` from the repo root. It is idempotent; `ONLY=server` or `ONLY=web` deploys one half.
- Do not print the OAuth client secret; tell the user the `gcloud secrets versions access` command instead.
