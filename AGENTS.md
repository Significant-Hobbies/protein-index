## Shared Fleet Standard

Also read and follow the shared fleet-level agent standard at `../AGENTS.md`.
Treat this repository as owned product code: protect production stability, keep
changes scoped, verify work, and record durable follow-up tasks when something
remains incomplete or blocked.

## Project

- **Stack**: Vite + React + Cloudflare Workers + D1 + R2
- **Package manager**: pnpm
- **Local dev**: `pnpm dev`
- **Checks**: `pnpm check`
- **Deploy**: `pnpm run deploy` after the reviewed data publication, clean-main,
  synced-remote, green-CI, and release-preflight gates pass

## Data rules

- A canonical product is not a retailer listing.
- Preserve field-level source provenance and observation timestamps.
- Keep retailer ratings and offers source-specific.
- Never silently overwrite higher-confidence nutrition with lower-confidence data.
- GTIN matching wins over inferred name matching; ambiguous inferred matches require review.
- Raw source payloads are evidence and must remain traceable to an ingestion run.
