// The lease must outlive the maximum Vercel invocation, including shutdown margin.
export const FUNCTION_MAX_DURATION_SECONDS = 300;
export const CYCLE_TIME_BUDGET_MS = 270_000;
export const CYCLE_LEASE_SECONDS = 360;
// O cron-job.org dispara no máximo uma vez por minuto. Dentro de cada chamada, novas passadas são
// feitas a cada CRON_REPEAT_INTERVAL_MS enquanto houver tempo antes do próximo disparo.
export const CRON_PASS_WINDOW_MS = 50_000;
export function readCronRepeatIntervalMs(value = process.env.CRON_REPEAT_INTERVAL_MS) {
    const interval = Number(value ?? 20_000);
    return Number.isFinite(interval) && interval >= 0 ? interval : 20_000;
}
// As conferências de fila (curtas) continuam até perto do próximo disparo, para não haver buraco
// sem aviso no fim de cada minuto; as passadas completas só começam até CRON_PASS_WINDOW_MS.
export const CRON_CHECK_WINDOW_MS = 56_000;
function readInterval(value: string | undefined, fallback: number) {
    const interval = Number(value ?? fallback);
    return Number.isFinite(interval) && interval >= 0 ? interval : fallback;
}
// Passada rápida da Arcoverde entre as completas: reposiciona por GPS e avisa (FAST_PASS_INTERVAL_MS). 0 desliga.
export function readFastPassIntervalMs(value = process.env.FAST_PASS_INTERVAL_MS) { return readInterval(value, 5_000); }
// Conferência só de fila da Arcoverde (uma leitura de status) para o aviso sair em segundos
// (DRIVER_MESSAGES_POLL_MS). 0 desliga.
export function readQueuePollIntervalMs(value = process.env.DRIVER_MESSAGES_POLL_MS) { return readInterval(value, 2_000); }
