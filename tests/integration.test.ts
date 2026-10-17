import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutocabClient, AutocabRequestError } from '../server/autocab.ts';
import type { AutocabGateway } from '../server/autocab.ts';
import { DemoAutocabClient } from '../server/demo.ts';
import { AuditRepository } from '../server/repository.ts';
import { CorrectionService } from '../server/correction-service.ts';
import { CorrectionScheduler } from '../server/scheduler.ts';
import { calculateQueueTail, chooseTargetZone, findOutsideZone } from '../server/rules.ts';
import { createApplication } from '../server/http.ts';
import type { AppConfig } from '../server/config.ts';
const rules = { protectedZoneNames: ['NAK', 'FORA DE AREA'], outsideZoneName: 'FORA DE AREA' };
function createService(mode: 'demo' | 'dry' | 'live', gateway: AutocabGateway = new DemoAutocabClient()) {
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, mode);
    const connection = { id: 'empresa-a', name: 'Empresa A', gateway };
    return { repository, service, connection };
}
test('dry consulta zonas, planeja GPS/ocupado e não envia POST', async () => {
    const gateway = new DemoAutocabClient();
    let plotCalls = 0;
    gateway.applyVehiclePlot = async () => { plotCalls++; return 200; };
    const { repository, service, connection } = createService('dry', gateway);
    await service.runConnection(connection);
    const dashboard = repository.getDashboard();
    assert.equal(dashboard.zones.length, 4);
    assert.equal(plotCalls, 0);
    assert.equal(dashboard.changes.length, 2);
    assert.ok(dashboard.changes.every(change => change.outcome === 'planned'));
    assert.ok(!dashboard.changes.some(change => [103, 104].includes(change.vehicleId)));
    repository.close();
});
test('live confirma mudança e mantém punidos/protegidos', async () => {
    const { repository, service, connection } = createService('live');
    await service.runConnection(connection);
    const changes = repository.getDashboard().changes;
    assert.equal(changes.length, 2);
    assert.ok(changes.every(change => change.outcome === 'confirmed'));
    assert.equal(changes.find(change => change.vehicleId === 101)?.position, 2);
    await service.runConnection(connection);
    assert.equal(repository.getDashboard().changes.length, 2);
    repository.close();
});
test('timeout deixa resultado incerto e impede novo envio ao mesmo veículo', async () => {
    const gateway = new DemoAutocabClient();
    let plotCalls = 0;
    gateway.applyVehiclePlot = async () => { plotCalls++; throw new AutocabRequestError('timeout'); };
    const { repository, service, connection } = createService('live', gateway);
    await service.runConnection(connection);
    await service.runConnection(connection);
    assert.equal(plotCalls, 2);
    assert.equal(repository.listUnresolvedChanges('empresa-a').length, 2);
    repository.close();
});
test('HTTP rejeitado é registrado separadamente de resultado incerto', async () => {
    const gateway = new DemoAutocabClient();
    gateway.applyVehiclePlot = async () => { throw new AutocabRequestError('forbidden', 403); };
    const { repository, service, connection } = createService('live', gateway);
    await service.runConnection(connection);
    assert.ok(repository.getDashboard().changes.every(change => change.outcome === 'failed' && change.httpStatus === 403));
    repository.close();
});
test('POST aceito sem mudança permanece não confirmado', async () => {
    const gateway = new DemoAutocabClient();
    gateway.applyVehiclePlot = async () => 202;
    const { repository, service, connection } = createService('live', gateway);
    await service.runConnection(connection);
    assert.ok(repository.getDashboard().changes.every(change => change.outcome === 'unconfirmed'));
    repository.close();
});
test('penalidade recebida após planejamento impede envio', async () => {
    const gateway = new DemoAutocabClient();
    const listStatuses = gateway.listVehicleStatuses.bind(gateway);
    let readCount = 0, plotCalls = 0;
    gateway.listVehicleStatuses = async () => { const statuses = await listStatuses(); if (++readCount > 1)
        for (const status of statuses)
            status.hasPenalty = true; return statuses; };
    gateway.applyVehiclePlot = async () => { plotCalls++; return 200; };
    const { repository, service, connection } = createService('live', gateway);
    await service.runConnection(connection);
    assert.equal(plotCalls, 0);
    assert.ok(repository.getDashboard().changes.every(change => change.outcome === 'skipped'));
    repository.close();
});
test('falha em lista obrigatória encerra ciclo sem aplicar e sem ocultar erro', async () => {
    const gateway = new DemoAutocabClient();
    gateway.listVehicleStatuses = async () => { throw new AutocabRequestError('Autocab respondeu HTTP 401', 401); };
    const { repository, service, connection } = createService('live', gateway);
    await service.runConnection(connection);
    assert.equal(repository.getDashboard().cycles[0].outcome, 'failed');
    assert.equal(repository.getDashboard().changes.length, 0);
    repository.close();
});
test('consulta sem chave gera diagnóstico persistente', async () => {
    const { repository, service } = createService('dry');
    await service.runConnection({ id: 'sem-chave', name: 'Sem chave', gateway: null });
    assert.match(repository.getDashboard().cycles[0].detail!, /Subscription Key ausente/);
    repository.close();
});
test('zonas e logs com mesmo ID ficam isolados por conexão', async () => {
    const { repository, service, connection } = createService('dry');
    await service.runConnection(connection);
    await service.runConnection({ ...connection, id: 'empresa-b' });
    assert.equal(repository.getDashboard().zones.length, 8);
    assert.equal(repository.getDashboard('empresa-a').zones.length, 4);
    assert.ok(repository.getDashboard('empresa-b').changes.every(change => change.connectionId === 'empresa-b'));
    repository.close();
});
test('companyId restringe veículos e é encaminhado para consulta GPS', async () => {
    const gateway = new DemoAutocabClient();
    const companies: number[] = [];
    const coordinateLookup: AutocabGateway['findZoneByCoordinates'] = async (_latitude, _longitude, companyId) => { companies.push(companyId!); return 2; };
    const { repository, service, connection } = createService('dry', { ...gateway, listCompanies: gateway.listCompanies.bind(gateway), listZones: gateway.listZones.bind(gateway), listVehicles: gateway.listVehicles.bind(gateway), listVehicleStatuses: gateway.listVehicleStatuses.bind(gateway), listGpsPositions: gateway.listGpsPositions.bind(gateway), applyVehiclePlot: gateway.applyVehiclePlot.bind(gateway), findZoneByCoordinates: coordinateLookup });
    await service.runConnection({ ...connection, companyId: 2 });
    assert.equal(repository.getDashboard().changes.length, 0);
    await service.runConnection({ ...connection, companyId: 1 });
    assert.ok(companies.length > 0 && companies.every(companyId => companyId === 1));
    repository.close();
});
test('fim da fila considera maior posição e posições ausentes', () => {
    assert.equal(calculateQueueTail([{ vehicleId: 1, zoneId: 2, queuePosition: 8, status: 'Available', hasPenalty: false }, { vehicleId: 2, zoneId: 2, queuePosition: null, status: 'Available', hasPenalty: false }], 2), 8);
});
test('livre pode sair de FORA DE AREA, ocupado não sai de zona protegida', () => {
    const outside = { id: 4, name: 'FORA DE AREA', companyId: 1 };
    const target = { id: 1, name: 'Centro', companyId: 1 };
    const status = { vehicleId: 101, zoneId: 4, queuePosition: 1, status: 'Available', hasPenalty: false };
    assert.equal(chooseTargetZone(status, outside, target, outside, rules)?.id, 1);
    assert.equal(chooseTargetZone({ ...status, status: 'Busy' }, { id: 3, name: 'NAK', companyId: 1 }, target, outside, rules), null);
    assert.throws(() => findOutsideZone([outside, { ...outside, id: 5 }], rules), /ambígua/);
});
test('cliente usa endpoints do core, autenticação e corpo exato do plot', async () => {
    const requests: {
        url: string;
        method: string;
        body: unknown;
    }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
        assert.equal(new Headers(init?.headers).get('Ocp-Apim-Subscription-Key'), 'test-key');
        requests.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
        const url = new URL(String(input));
        if (url.pathname.endsWith('/plot'))
            return new Response(null, { status: 204 });
        if (url.pathname.endsWith('/zone'))
            return Response.json({ id: 2 });
        if (url.pathname.endsWith('/zones'))
            return Response.json([{ id: 1, name: 'Centro', companyId: 1 }]);
        return Response.json([]);
    };
    const client = new AutocabClient('https://autocab-api.azure-api.net', 'test-key', fakeFetch);
    await client.listZones();
    await client.listVehicles();
    await client.listVehicleStatuses();
    await client.listGpsPositions();
    assert.equal(await client.findZoneByCoordinates(-23, -46, 1), 2);
    await client.applyVehiclePlot(101, 2, 3);
    assert.deepEqual(requests.map(request => new URL(request.url).pathname), ['/booking/v1/zones', '/vehicle/v1/vehicles', '/vehicle/v1/vehiclestatuses', '/vehicle/v1/vehiclegpsposition', '/booking/v1/zone', '/vehicle/v1/vehicles/101/plot']);
    assert.deepEqual(requests.at(-1)?.body, { vehicleId: 101, zoneId: 2, position: 3 });
    assert.equal(requests.at(-1)?.method, 'POST');
    assert.equal(new URL(requests[4].url).searchParams.get('companyId'), '1');
});
test('cliente falha em formato inesperado e descarta GPS inválido', async () => {
    const invalidClient = new AutocabClient('https://autocab-api.azure-api.net', 'test-key', async () => Response.json({ items: [] }));
    await assert.rejects(invalidClient.listZones(), /não é uma lista/);
    const gpsClient = new AutocabClient('https://autocab-api.azure-api.net', 'test-key', async () => Response.json([{ id: 1, location: { latitude: null, longitude: 1 } }, { id: 2, location: { latitude: 0, longitude: 0 } }, { id: 3, location: { latitude: -23, longitude: -46 } }]));
    assert.deepEqual((await gpsClient.listGpsPositions()).map(position => position.vehicleId), [3]);
});
test('SQLite conserva histórico e recuperação marca envio interrompido', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autocab-test-'));
    const path = join(directory, 'audit.sqlite');
    let repository = new AuditRepository(path);
    const cycleId = repository.startCycle('principal', 'live');
    const changeId = repository.createChange('principal', cycleId, 'live', { vehicleId: 101, callsign: '101', previousZoneId: 1, previousZoneName: 'Centro', targetZoneId: 2, targetZoneName: 'Estação', position: 2, reason: 'gps', latitude: -23, longitude: -46 }, 'pending');
    repository.close();
    repository = new AuditRepository(path);
    repository.recoverInterruptedCycles();
    assert.equal(repository.getDashboard().changes[0].id, changeId);
    assert.equal(repository.getDashboard().changes[0].outcome, 'unknown');
    assert.equal(repository.getDashboard().cycles[0].outcome, 'interrupted');
    repository.close();
    rmSync(directory, { recursive: true });
});
test('painel exige token e fornece logs/zonas após ciclo HTTP', async () => {
    const { repository, service, connection } = createService('demo');
    const scheduler = new CorrectionScheduler(service, [connection], 60000);
    const config: AppConfig = { mode: 'demo', baseUrl: 'https://autocab-api.azure-api.net', databasePath: ':memory:', host: '127.0.0.1', port: 3001, panelToken: 'panel-test', intervalMs: 60000, autoStart: false, ...rules, companiesPath: '/booking/v1/companies', connections: [] };
    const application = createApplication(config, repository, scheduler, [connection]);
    const server = application.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: 'Bearer panel-test' };
    try {
        assert.equal((await fetch(baseUrl + '/api/dashboard')).status, 401);
        assert.equal((await fetch(baseUrl + '/api/cycles', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
        assert.equal((await fetch(baseUrl + '/api/cycles', { method: 'POST', headers })).status, 200);
        const dashboard = await (await fetch(baseUrl + '/api/dashboard', { headers })).json();
        assert.equal(dashboard.changes.length, 2);
        assert.equal(dashboard.zones.length, 4);
    }
    finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        repository.close();
    }
});
test('envios para mesma zona reservam posições distintas mesmo com leitura atrasada', async () => {
    const gateway = new DemoAutocabClient();
    const initialStatuses = await gateway.listVehicleStatuses();
    initialStatuses[1] = { ...initialStatuses[1], zoneId: 1, status: 'Available' };
    let statusReads = 0;
    gateway.listVehicleStatuses = async () => {
        statusReads++;
        const statuses = structuredClone(initialStatuses);
        if (statusReads > 1)
            statuses.push({ vehicleId: 999, zoneId: 2, queuePosition: 10, status: 'Available', hasPenalty: false });
        return statuses;
    };
    const sentPositions: number[] = [];
    gateway.applyVehiclePlot = async (_vehicleId, _zoneId, position) => { sentPositions.push(position); return 202; };
    const { repository, service, connection } = createService('live', gateway);
    await service.runConnection(connection);
    assert.deepEqual(sentPositions, [11, 12]);
    repository.close();
});
test('agendador rejeita ciclos sobrepostos', async () => {
    const gateway = new DemoAutocabClient();
    let releaseLookup: () => void = () => { };
    const waitForLookup = new Promise<void>(resolve => { releaseLookup = resolve; });
    const originalListZones = gateway.listZones.bind(gateway);
    gateway.listZones = async () => { await waitForLookup; return originalListZones(); };
    const { repository, service, connection } = createService('dry', gateway);
    const scheduler = new CorrectionScheduler(service, [connection], 60000);
    const firstCycle = scheduler.runOnce();
    await assert.rejects(scheduler.runOnce(), /andamento/);
    releaseLookup();
    await firstCycle;
    assert.equal(repository.getDashboard().cycles.length, 1);
    await scheduler.stop();
    repository.close();
});
