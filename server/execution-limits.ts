// The lease must outlive the maximum Vercel invocation, including shutdown margin.
export const FUNCTION_MAX_DURATION_SECONDS = 300;
export const CYCLE_TIME_BUDGET_MS = 270_000;
export const CYCLE_LEASE_SECONDS = 360;
// O cron da Vercel dispara no máximo uma vez por minuto. Dentro de cada chamada, novas passadas são
// feitas a cada CRON_REPEAT_INTERVAL_MS enquanto houver tempo antes do próximo disparo.
export const CRON_PASS_WINDOW_MS = 45_000;
export function readCronRepeatIntervalMs(value = process.env.CRON_REPEAT_INTERVAL_MS) {
    const interval = Number(value ?? 20_000);
    return Number.isFinite(interval) && interval >= 0 ? interval : 20_000;
}
