---
title: Product overview
description: What Protein Index is, who it is for, and what is in and out of scope.
---

# Product overview

Protein Index is a normalized Indian protein-product intelligence database. It
turns fragmented catalog, label, retailer, and brand data into comparable
canonical products with source-aware nutrition, offers, ratings, confidence,
and protein-value metrics.

The product record is canonical. Retailer listings are observations attached to
that record, never the source of identity by themselves. Broad imports ingest
all India-tagged foods first and classify protein products afterward.

Live dashboard: <https://protein.significanthobbies.com>

## Users

- Indian shoppers comparing protein foods.
- Operators reviewing or correcting product data.

## In scope (first release)

- Broad ingestion of Indian food records.
- Canonical GTIN-based products.
- Separate marketed and nutrition-derived protein classification.
- Verified nutrition; raw and normalized ingredients, allergens, additives.
- Configured-source coverage accounting.
- Source-specific offers and ratings.
- Provenance and confidence.
- Deterministic protein and value metrics.
- Entity-resolution and nutrition-conflict review.

## Out of scope (first release)

- Claiming complete Indian-market coverage.
- Collapsing retailer ratings into one score.
- Unlicensed permanent copies of retailer content.
- Autonomous acceptance of ambiguous product matches.
- ONDC integration.
- Purchasing or checkout.

## Completion gate

Deployment is not completion. The product remains incomplete until every active
product has terminal verified identity, nutrition, and ingredient evidence, or
a current label/authoritative source explicitly establishes that a field is not
applicable or not declared. Every configured source must also reconcile without
unexplained gaps, and the rendered dashboard must pass desktop/mobile
verification.

A release may finish with a small, explicitly enumerated and reason-coded
unverified exception queue. Those rows remain excluded from Trusted rankings,
and the dashboard continues to report data completion as incomplete until the
strict terminal-evidence gate is satisfied.

## Two evidence boundaries

The dashboard exposes two explicit modes:

- **Trusted** shows protein-relevant products only when exact current identity,
  authority-100 verified nutrition, and terminal ingredient evidence all agree.
- **Discovery** exposes comparison metrics only when structured nutrition
  passes validation, keeps community evidence visibly unverified, and withholds
  missing or conflicting values.

Missing values stay missing. Open Food Facts values are never promoted to
label-verified facts merely because they parse successfully.

## See also

- [Evidence policy](evidence-policy.md) for the four evidence states and trust
  boundaries.
- [Sources](sources.md) for the Open Food Facts bootstrap, DataKart status, and
  hosted publication policy.
- [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md) for the durable timeline and
  the live todo / blocked list.
