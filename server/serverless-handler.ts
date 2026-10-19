import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createNeonRuntime, CycleAlreadyRunningError } from './neon-runtime.ts';
import { listCompaniesForConnections } from './companies.ts';
import { CRON_PASS_WINDOW_MS, readCronRepeatIntervalMs } from './execution-limits.ts';
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
export function createServerlessHandler(loadRuntime: () => Promise<NeonRuntime>) {
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
        const isRead = request.method === 'GET' && (path === '/api/status' || path === '/api/dashboard' || path === '/api/companies');
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
                sendJson(response, 200, { mode: runtime.configuration.mode, running: runtime.runner.running, autoStart: false, intervalMs: runtime.configuration.intervalMs, execution: 'serverless', connections: runtime.connections.map(connection => ({ id: connection.id, name: connection.name, configured: connection.gateway !== null, companyId: connection.companyId, companyName: connection.companyName })) });
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
            if (path === '/api/dashboard') {
                sendJson(response, 200, await runtime.repository.getDashboard(query.get('connectionId')));
                return;
            }
            const startedAt = Date.now();
            await runtime.runner.runOnce();
            if (isCron) {
                // Passadas extras corrigem mais rápido que o intervalo mínimo do cron; só repete
                // quando a passada anterior terminou todas as empresas e ainda cabe outra no minuto.
                const repeatIntervalMs = readCronRepeatIntervalMs();
                while (repeatIntervalMs > 0 && runtime.runner.lastRunCompleted && Date.now() - startedAt + repeatIntervalMs < CRON_PASS_WINDOW_MS) {
                    await new Promise(resolve => setTimeout(resolve, repeatIntervalMs));
                    await runtime.runner.runOnce();
                }
            }
            sendJson(response, 200, { completed: true, note: 'Consulte o histórico de ciclos para resultados e lotes pendentes.' });
        }
        catch (error) {
            if (error instanceof CycleAlreadyRunningError) {
                sendJson(response, 409, { error: 'Ciclo já em andamento em outra execução' });
                return;
            }
            console.error('Falha ao executar a rota no backend');
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
