## Why

The current catalog has only 12 products in its strict `protein_snack` category,
although the retained complete Open Food Facts India snapshot contains 791
products marketed as protein. Protein puffs, wafers, makhana and similar
products are being hidden because canonical food category and shopper discovery
intent are being treated as the same thing.

## What Changes

- Add a separate **Protein-branded discovery** cohort that includes product
  claim evidence and explicit protein-related brand wording without changing
  canonical categories.
- Broaden protein-related claim detection for current Open Food Facts source
  records while retaining each reason for auditability.
- Make catalog search match product name, brand, raw category and stored
  marketing reasons, so multi-word shopper searches work across the available
  source metadata.
- Expose the cohort in the dashboard scope control, with clear language that it
  is a discovery collection rather than a nutrition or verification claim.

## Impact

- Affects classifier inputs, Open Food Facts normalization, catalog API filters
  and search, dashboard scope controls, and focused regression tests.
- Does not change canonical categories, nutrition evidence, strict trust, or
  make the configured Open Food Facts source exhaustive for the Indian market.
