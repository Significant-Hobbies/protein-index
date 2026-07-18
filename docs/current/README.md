---
title: Current state
description: Where to find the live current-state view and how it relates to this docs tree.
---

# Current state

The live, append-only current-state view lives at
[`STATUS.md`](../../STATUS.md) (short view) and
[`PROJECT_STATUS.md`](../../PROJECT_STATUS.md) (durable timeline). This folder
exists only to anchor the docs navigation; it does not duplicate those files.

## What lives where

| File | Purpose | Update cadence |
| --- | --- | --- |
| [`STATUS.md`](../../STATUS.md) | Current objective, active work, blockers, unresolved questions, next steps | Each working session |
| [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md) | Durable append-only timeline, shipped features, todo/blocked list | Each PR-sized change |
| [`docs/`](../index.md) | Stable product, architecture, operations, and knowledge docs | When the system changes |

## Rule

Do not copy live state into `docs/current/`. Link to `STATUS.md` instead. If a
fact is stable (not live state), it belongs in the relevant `docs/` page, not
here.
