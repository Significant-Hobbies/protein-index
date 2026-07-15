export const DATAKART_ADAPTER_STATUS = {
  id: "gs1_india_datakart",
  enabled: false,
  authority: "official_brand_owner",
  updateStrategy: "near_real_time_or_delta_per_commercial_contract",
  requiredInputs: [
    "Registered GS1 India solution-provider account",
    "Permitted API schema and endpoint documentation",
    "Credential delivery mechanism",
    "Rate-limit and delta/update semantics",
    "Retention, display, redistribution, and derived-data terms",
  ],
} as const;

export function assertDataKartConfigured(): never {
  throw new Error(
    "DataKart adapter is disabled: commercial GS1 India access, private API documentation, and permitted retention terms are required.",
  );
}
