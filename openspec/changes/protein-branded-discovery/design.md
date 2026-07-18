## Context

Canonical categories are intended for comparison and filtering; they are not a
complete representation of food branding. Reclassifying puffs, wafers and
makhana as `protein_snack` would make the schema less truthful and still miss
protein-branded products in other categories.

## Decisions

### Keep category and discovery cohort independent

`category` remains the existing canonical field. The new scope is a query-time
cohort: current product-level `marketed_protein` evidence plus narrowly matched
brand wording (`protein`, `whey`, `casein`). The latter is intentionally a
discovery inclusion, not a product-level marketing assertion: a brand may also
sell unrelated products.

### Store reasons and do not infer nutrition

Product claims continue to come from product name, categories and labels. The
normalizer additionally passes brand wording to the classifier and stores a
separate reason such as `brand_contains_protein`. This changes discovery only;
it neither modifies nutrition density nor evidence status.

### Search all retained discovery text

Each normalized query token searches name, brand, flavour, GTIN, canonical
category, raw category and marketing-reason JSON. This supports queries such as
`protein snacks` where those words live in different retained fields. It is a
small, portable SQLite change with no FTS migration.

## Risks

- Brand wording can include non-protein products. The UI calls this a discovery
  cohort and it remains separate from the product claim flag.
- Broader category text can surface irrelevant results. The dashboard retains
  category, nutrition and evidence controls so users can refine results.
