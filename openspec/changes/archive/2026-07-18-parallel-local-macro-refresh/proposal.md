## Why

The no-cost refresh currently crawls each independent first-party brand source
one at a time. With sixteen configured brands, this makes the freshest
source-bounded macro catalog unnecessarily slow despite the sources being on
separate hosts and already having per-host request intervals.

## What Changes

- Add a bounded, deterministic concurrency control for independent official
  brand discovery during a local macro refresh.
- Preserve a complete terminal outcome for every configured source and keep
  output ordering stable regardless of completion order.
- Expose the selected concurrency in the refresh report and local CLI while
  retaining the existing serial-safe behavior as an explicit option.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `zero-cost-macro-refresh`: local source refresh may execute independent
  configured brand sources concurrently while retaining source-bounded,
  non-publishing completion guarantees.

## Impact

- `scripts/macro-refresh.ts` command orchestration and report contract.
- Local operations documentation and unit tests.
- No Worker, D1, R2, production deployment, credentials, or paid dependency
  changes.
