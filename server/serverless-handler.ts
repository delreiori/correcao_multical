import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createNeonRuntime, CycleAlreadyRunningError } from './neon-runtime.ts';
import { listCompaniesForConnections } from './companies.ts';
import { CRON_PASS_WINDOW_MS, readCronRepeatIntervalMs, readQueuePollIntervalMs } from './execution-limits.ts';
import { waitUntil } from '@vercel/functions';
export type NeonRuntime = Awaited<ReturnType<typeof createNeonRuntime>>;
function hasBearerToken(request: IncomingMessage, token: string) {
    if (!token)
        return false;
    const supplied = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function sendJson(response: ServerResponse, status: number, payload: unknown) { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.end(JSON.stringify(payload)); }
function getRequestPath(request: IncomingMessage) {
    const url = new URL(request.url || '/', 'http://internal');
    const rewrittenRoute = url.searchParams.get('route');
    return { path: rewrittenRoute ? '/api/' + rewrittenRoute : url.pathname, query: url.searchParams };
}
function hasValidOrigin(request: IncomingMessage) {
    if (!request.headers.origin)
        return true;
    try {
        return new URL(request.headers.origin).host === request.headers.host;
    }
    catch {
        return false;
    }
}
// Só o tipo/código do erro: mensagens do banco podem trazer dados da conexão.
function logBackendError(context: string, error: unknown) {
    const errorCode = error && typeof error === 'object' && 'code' in error ? ` (${String(error.code)})` : '';
    console.error(`${context}: ${error instanceof Error ? error.name : 'erro'}${errorCode}`);
}
// Passadas do cron: a primeira e, enquanto couberem antes do próximo disparo, passadas extras a cada
// CRON_REPEAT_INTERVAL_MS. Nunca rejeita; o resultado fica no histórico de ciclos e no log.
export async function runCronPasses(runtime: Pick<NeonRuntime, 'runner' | 'connections'>, windowMs = CRON_PASS_WINDOW_MS) {
    const startedAt = Date.now();
    const repeatIntervalMs = readCronRepeatIntervalMs();
    // Só confere filas entre passadas se alguma empresa tem aviso aos motoristas.
    const pollIntervalMs = runtime.connections.some(connection => connection.driverMessages) ? readQueuePollIntervalMs() : 0;
    const windowEnd = startedAt + windowMs;
    // Espera até o horário indicado; nesse meio tempo confere as filas com aviso a cada pollIntervalMs,
    // para o motorista ser avisado em segundos, sem esperar a próxima passada completa.
    async function waitWithQueueChecks(until: number) {
        while (Date.now() < until) {
            const nextCheck = pollIntervalMs > 0 ? Math.min(until, Date.now() + pollIntervalMs) : until;
            await new Promise(resolve => setTimeout(resolve, Math.max(0, nextCheck - Date.now())));
            if (pollIntervalMs > 0 && Date.now() < windowEnd)
                await runtime.runner.runQuickQueueCheck();
        }
    }
    let lastPassMs = 0;
    try {
        for (let pass = 0; pass === 0 || (repeatIntervalMs > 0 && runtime.runner.lastRunCompleted && Date.now() + repeatIntervalMs + lastPassMs < windowEnd); pass++) {
            if (pass > 0)
                await waitWithQueueChecks(Date.now() + repeatIntervalMs);
            const passStartedAt = Date.now();
            await runtime.runner.runOnce();
            lastPassMs = Date.now() - passStartedAt;
        }
        // Sem tempo para outra passada completa: segue só conferindo as filas até o fim da janela.
        if (pollIntervalMs > 0)
            await waitWithQueueChecks(windowEnd - pollIntervalMs);
    }
    catch (error) {
        // Execução anterior (ou de outro disparo) ainda ativa: este disparo só é pulado.
        if (error instanceof CycleAlreadyRunningError)
            console.log('Cron pulado: ciclo anterior ainda em andamento.');
        else
            logBackendError('Falha no ciclo do cron', error);
    }
}
// Na Vercel, waitUntil mantém a função viva após a resposta até o fim das passadas.
function runOnVercelInBackground(work: Promise<void>) { waitUntil(work); return Promise.resolve(); }
export function createServerlessHandler(loadRuntime: () => Promise<NeonRuntime>, runInBackground: (work: Promise<void>) => Promise<void> = runOnVercelInBackground) {
    return async (request: IncomingMessage, response: ServerResponse) => {
        const { path, query } = getRequestPath(request);
        const isCron = path === '/api/cron';
        const expectedToken = isCron ? process.env.CRON_SECRET : process.env.PANEL_TOKEN;
        if (!expectedToken) {
            const message = `Configure ${isCron ? 'CRON_SECRET' : 'PANEL_TOKEN'} na Vercel e faça Redeploy.`;
            console.error(message);
            sendJson(response, 503, { error: message });
            return;
        }
        if (!hasBearerToken(request, expectedToken)) {
            sendJson(response, 401, { error: 'Token inválido ou ausente' });
            return;
        }
        if (request.method === 'POST' && !hasValidOrigin(request)) {
            sendJson(response, 403, { error: 'Origem não permitida' });
            return;
        }
        const isRead = request.method === 'GET' && (path === '/api/status' || path === '/api/dashboard' || path === '/api/companies' || path === '/api/messages');
        const isCycle = (request.method === 'GET' && isCron) || (request.method === 'POST' && path === '/api/cycles');
        if (!isRead && !isCycle) {
            sendJson(response, 404, { error: 'Rota não encontrada' });
            return;
        }
        let runtime: NeonRuntime;
        try {
            runtime = await loadRuntime();
        }
        catch (error) {
            // Mensagens de configuração são próprias (sem credenciais); mostram qual variável falta.
            const message = error instanceof Error ? error.message : 'Falha ao iniciar o backend';
            console.error(`Backend não iniciou: ${message}`);
            sendJson(response, 503, { error: `${message}. Confira as variáveis da Vercel e faça Redeploy.` });
            return;
        }
        try {
            if (path === '/api/status') {
                sendJson(response, 200, { mode: runtime.configuration.mode, reservationMessagesMode: runtime.configuration.reservationMessagesMode ?? 'off', running: runtime.runner.running, autoStart: false, intervalMs: runtime.configuration.intervalMs, execution: 'serverless', connections: runtime.connections.map(connection => ({ id: connection.id, name: connection.name, configured: connection.gateway !== null, companyId: connection.companyId, companyName: connection.companyName })) });
                return;
            }
            if (path === '/api/companies') {
                try {
                    sendJson(response, 200, await listCompaniesForConnections(runtime.connections));
                }
                catch (error) {
                    sendJson(response, 502, { error: error instanceof Error ? error.message : 'Falha ao consultar empresas' });
                }
                return;
            }
            if (path === '/api/messages') {
                const kind = query.get('kind');
                sendJson(response, 200, { messages: await runtime.repository.listDriverMessages(query.get('connectionId'), 1000, kind === 'queue' || kind === 'reservations' ? kind : undefined) });
                return;
            }
            if (path === '/api/dashboard') {
                sendJson(response, 200, await runtime.repository.getDashboard(query.get('connectionId')));
                return;
            }
            if (isCron) {
                // O cron-job.org desiste após 30 s: responde já e segue com as passadas em segundo plano.
                await runInBackground(runCronPasses(runtime));
                sendJson(response, 202, { accepted: true, note: 'Ciclo iniciado em segundo plano; consulte o histórico de ciclos no painel.' });
                return;
            }
            await runtime.runner.runOnce();
            sendJson(response, 200, { completed: true, note: 'Consulte o histórico de ciclos para resultados e lotes pendentes.' });
        }
        catch (error) {
            if (error instanceof CycleAlreadyRunningError) {
                sendJson(response, 409, { error: 'Ciclo já em andamento em outra execução' });
                return;
            }
            logBackendError('Falha ao executar a rota no backend', error);
            sendJson(response, 503, { error: 'Falha ao acessar o backend. Confira DATABASE_URL e as configurações da Vercel.' });
        }
    };
}
let runtimePromise: Promise<NeonRuntime> | null = null;
function loadRuntime() {
    if (!runtimePromise)
        runtimePromise = createNeonRuntime().catch(error => { runtimePromise = null; throw error; });
    return runtimePromise;
}
export const serverlessHandler = createServerlessHandler(loadRuntime);
