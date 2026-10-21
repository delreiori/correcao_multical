import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import type { AppConfig } from './config.ts';
import type { AuditStore } from './audit-store.ts';
import type { CycleRuntime } from './neon-runtime.ts';
import type { CorrectionConnection } from './correction-service.ts';
import { listCompaniesForConnections } from './companies.ts';
function authenticatePanel(panelToken: string) {
    return (request: Request, response: Response, next: NextFunction) => {
        if (!panelToken) {
            next();
            return;
        }
        const receivedToken = Buffer.from(request.headers.authorization || '');
        const expectedToken = Buffer.from(`Bearer ${panelToken}`);
        if (receivedToken.length !== expectedToken.length || !timingSafeEqual(receivedToken, expectedToken)) {
            response.status(401).json({ error: 'Informe o token do painel.' });
            return;
        }
        next();
    };
}
function validateRequestOrigin(request: Request, response: Response, next: NextFunction) {
    if (['GET', 'HEAD'].includes(request.method) || !request.headers.origin) {
        next();
        return;
    }
    try {
        if (new URL(request.headers.origin).host === request.headers.host) {
            next();
            return;
        }
    }
    catch { }
    response.status(403).json({ error: 'Origem não permitida' });
}
export function createApplication(config: AppConfig, repository: AuditStore, scheduler: CycleRuntime, connections: CorrectionConnection[]) {
    const application = express();
    application.disable('x-powered-by');
    application.use(express.json({ limit: '16kb' }));
    application.use('/api', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
    application.use('/api', authenticatePanel(config.panelToken), validateRequestOrigin);
    application.get('/api/status', (_request, response) => response.json({ mode: config.mode, running: scheduler.running, autoStart: config.autoStart, intervalMs: config.intervalMs, connections: connections.map(connection => ({ id: connection.id, name: connection.name, configured: connection.gateway !== null, companyId: connection.companyId, companyName: connection.companyName })) }));
    application.get('/api/companies', async (_request, response) => {
        try {
            response.json(await listCompaniesForConnections(connections));
        }
        catch (error) {
            response.status(502).json({ error: error instanceof Error ? error.message : 'Falha ao consultar empresas' });
        }
    });
    application.get('/api/messages', async (request, response) => {
        const connectionId = typeof request.query.connectionId === 'string' ? request.query.connectionId : null;
        response.json({ messages: await repository.listDriverMessages?.(connectionId) ?? [] });
    });
    application.get('/api/dashboard', async (request, response) => {
        const connectionId = typeof request.query.connectionId === 'string' ? request.query.connectionId : null;
        response.json(await repository.getDashboard(connectionId));
    });
    application.post('/api/cycles', async (_request, response) => {
        if (scheduler.running) {
            response.status(409).json({ error: 'Já existe um ciclo em andamento' });
            return;
        }
        try {
            await scheduler.runOnce();
            response.json({ completed: true });
        }
        catch {
            response.status(500).json({ error: 'Falha no ciclo; consulte o histórico' });
        }
    });
    application.use(express.static(resolve('dist')));
    application.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => { response.status(500).json({ error: 'Não foi possível concluir a solicitação' }); });
    return application;
}
