// The lease must outlive the maximum Vercel invocation, including shutdown margin.
export const FUNCTION_MAX_DURATION_SECONDS = 300;
export const CYCLE_TIME_BUDGET_MS = 270_000;
export const CYCLE_LEASE_SECONDS = 360;
