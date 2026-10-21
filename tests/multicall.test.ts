import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutocabClient } from '../server/autocab.ts';
import { DemoAutocabClient } from '../server/demo.ts';
import { AuditRepository } from '../server/repository.ts';
import { CorrectionService } from '../server/correction-service.ts';
import { readConfiguration } from '../server/config.ts';
const rules = { protectedZoneNames: ['NAK', 'FORA DE AREA'], outsideZoneName: 'FORA DE AREA' };
// Uma chave Multicall com duas empresas: veículo 201 é da Arcoverde (1) e 202 da São Conrado (2).
function createMulticallGateway() {
    const gateway = new DemoAutocabClient();
    const plots: number[] = [];
    gateway.listZones = async () => [
        { id: 10, name: 'Centro', companyId: 1 }, { id: 11, name: 'Praia', companyId: 1 }, { id: 12, name: 'FORA DE AREA', companyId: 1 },
        { id: 20, name: 'Centro', companyId: 2 }, { id: 21, name: 'Praia', companyId: 2 }, { id: 22, name: 'FORA DE AREA', companyId: 2 },
    ];
    gateway.listVehicles = async () => [{ id: 201, callsign: 'A1', companyId: 1 }, { id: 202, callsign: 'S1', companyId: 2 }];
    gateway.listVehicleStatuses = async () => [
        { vehicleId: 201, zoneId: 10, queuePosition: 1, status: 'Available', hasPenalty: false },
        { vehicleId: 202, zoneId: 20, queuePosition: 1, status: 'Available', hasPenalty: false },
    ];
    gateway.listGpsPositions = async () => [{ vehicleId: 201, latitude: -22.9, longitude: -43.2 }, { vehicleId: 202, latitude: -22.99, longitude: -43.25 }];
    gateway.findZoneByCoordinates = async (_latitude, _longitude, companyId) => companyId === 1 ? 11 : companyId === 2 ? 21 : null;
    gateway.applyVehiclePlot = async vehicleId => { plots.push(vehicleId); return 200; };
    return { gateway, plots };
}
test('cada empresa resolvida pelo nome corrige apenas os próprios veículos e zonas', async () => {
    const { gateway } = createMulticallGateway();
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, 'dry');
    await service.runConnection({ id: 'sao-conrado', name: 'São Conrado', companyName: 'Sao Conrado', gateway });
    const dashboard = repository.getDashboard('sao-conrado');
    assert.deepEqual(dashboard.changes.map(change => [change.vehicleId, change.targetZoneId]), [[202, 21]]);
    assert.ok(dashboard.zones.every(zone => zone.companyId === 2));
    assert.equal(dashboard.cycles[0].outcome, 'completed');
    repository.close();
});
test('empresa não encontrada falha o ciclo sem corrigir a frota inteira', async () => {
    const { gateway, plots } = createMulticallGateway();
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, 'live');
    await service.runConnection({ id: 'x', name: 'Inexistente', companyName: 'Inexistente', gateway });
    const dashboard = repository.getDashboard('x');
    assert.equal(dashboard.cycles[0].outcome, 'failed');
    assert.match(dashboard.cycles[0].detail ?? '', /não encontrada.*Arcoverde/);
    assert.equal(dashboard.changes.length, 0);
    assert.equal(plots.length, 0);
    repository.close();
});
test('GET de empresas lê a lista e, sem o endpoint, usa os companyId de zonas e veículos', async () => {
    let companiesStatus = 200;
    const fakeFetch = (async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname;
        if (path === '/booking/v1/companies')
            return companiesStatus === 200 ? Response.json([{ id: 7, name: 'Arcoverde' }, { id: 8, companyName: 'Pedra da Gávea' }]) : new Response('', { status: 404 });
        if (path === '/booking/v1/zones')
            return Response.json([{ id: 1, name: 'Centro', companyId: 8 }]);
        return Response.json([{ id: 5, callsign: '5', companyId: 7 }]);
    }) as typeof fetch;
    const client = new AutocabClient('https://autocab-api.azure-api.net', 'key', fakeFetch);
    assert.deepEqual(await client.listCompanies(), [{ id: 7, name: 'Arcoverde' }, { id: 8, name: 'Pedra da Gávea' }]);
    companiesStatus = 404;
    assert.deepEqual(await client.listCompanies(), [{ id: 7, name: null }, { id: 8, name: null }]);
});
test('configuração padrão cria Arcoverde, São Conrado e Pedra da Gávea com a mesma chave', () => {
    const previous = process.env.AUTOCAB_COMPANY_ID_ARCOVERDE;
    process.env.AUTOCAB_COMPANY_ID_ARCOVERDE = '42';
    try {
        const { connections } = readConfiguration();
        assert.deepEqual(connections.map(connection => connection.id), ['arcoverde', 'sao-conrado', 'pedra-da-gavea']);
        assert.ok(connections.every(connection => connection.subscriptionKeyEnvironmentVariable === 'AUTOCAB_SUBSCRIPTION_KEY'));
        assert.equal(connections[0].companyId, 42);
    }
    finally {
        if (previous === undefined) delete process.env.AUTOCAB_COMPANY_ID_ARCOVERDE;
        else process.env.AUTOCAB_COMPANY_ID_ARCOVERDE = previous;
    }
});
test('as três empresas rodam no mesmo ciclo e empresa sem FORA DE AREA ainda corrige por GPS', async () => {
    const { gateway } = createMulticallGateway();
    gateway.listCompanies = async () => [{ id: 1, name: 'Arcoverde Táxi' }, { id: 2, name: 'São Conrado' }, { id: 3, name: 'Pedra da Gávea' }];
    const baseZones = await gateway.listZones();
    gateway.listZones = async () => [...baseZones.filter(zone => !(zone.companyId === 1 && zone.name === 'FORA DE AREA')), { id: 30, name: 'Centro', companyId: 3 }, { id: 31, name: 'Praia', companyId: 3 }];
    gateway.listVehicles = async () => [{ id: 201, callsign: 'A1', companyId: 1 }, { id: 202, callsign: 'S1', companyId: 2 }, { id: 203, callsign: 'P1', companyId: 3 }];
    gateway.listVehicleStatuses = async () => [
        { vehicleId: 201, zoneId: 10, queuePosition: 1, status: 'Available', hasPenalty: false },
        { vehicleId: 202, zoneId: 20, queuePosition: 1, status: 'Available', hasPenalty: false },
        { vehicleId: 203, zoneId: 30, queuePosition: 1, status: 'Available', hasPenalty: false },
    ];
    gateway.listGpsPositions = async () => [201, 202, 203].map(vehicleId => ({ vehicleId, latitude: -22.9, longitude: -43.2 }));
    gateway.findZoneByCoordinates = async (_latitude: number, _longitude: number, companyId?: number) => companyId === 1 ? 11 : companyId === 2 ? 21 : companyId === 3 ? 31 : null;
    const { PGlite } = await import('@electric-sql/pglite');
    const { PostgresAuditRepository } = await import('../server/postgres-repository.ts');
    const { NeonCycleRunner } = await import('../server/neon-runtime.ts');
    const database = new PGlite();
    const repository = new PostgresAuditRepository({ query: async (sql, parameters) => sql.includes(';') && !parameters ? (await database.exec(sql), { rows: [] }) : { rows: (await database.query(sql, parameters)).rows as Record<string, unknown>[] } });
    await repository.initialize();
    const connections = [
        { id: 'arcoverde', name: 'Arcoverde', companyName: 'Arcoverde', gateway },
        { id: 'sao-conrado', name: 'São Conrado', companyName: 'São Conrado', gateway },
        { id: 'pedra-da-gavea', name: 'Pedra da Gávea', companyName: 'Pedra da Gávea', gateway },
    ];
    await new NeonCycleRunner(repository, new CorrectionService(repository, rules, 'dry'), connections).runOnce();
    const dashboard = await repository.getDashboard();
    assert.deepEqual(dashboard.cycles.map(cycle => [cycle.connectionId, cycle.outcome]).sort(), [['arcoverde', 'completed'], ['pedra-da-gavea', 'completed'], ['sao-conrado', 'completed']]);
    assert.deepEqual(dashboard.changes.map(change => [change.connectionId, change.vehicleId, change.targetZoneId]).sort(), [['arcoverde', 201, 11], ['pedra-da-gavea', 203, 31], ['sao-conrado', 202, 21]]);
    assert.match(dashboard.cycles.find(cycle => cycle.connectionId === 'arcoverde')?.detail ?? '', /companyId 1: 1 veículos.*FORA DE AREA não existe/);
    await database.close();
});
test('intervalo de passadas extras do cron aceita 0 e usa 20 s como padrão', async () => {
    const { readCronRepeatIntervalMs } = await import('../server/execution-limits.ts');
    assert.equal(readCronRepeatIntervalMs(undefined), 20000);
    assert.equal(readCronRepeatIntervalMs('0'), 0);
    assert.equal(readCronRepeatIntervalMs('abc'), 20000);
});
test('as empresas da mesma chave reaproveitam uma única leitura da frota no ciclo', async () => {
    const { gateway } = createMulticallGateway();
    let statusReads = 0;
    const listStatuses = gateway.listVehicleStatuses.bind(gateway);
    gateway.listVehicleStatuses = async () => { statusReads++; return listStatuses(); };
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, 'dry');
    const snapshotCache = new Map();
    await service.runConnection({ id: 'arcoverde', name: 'Arcoverde', companyId: 1, gateway }, { snapshotCache });
    await service.runConnection({ id: 'sao-conrado', name: 'São Conrado', companyId: 2, gateway }, { snapshotCache });
    assert.equal(statusReads, 1);
    assert.equal(repository.getDashboard().changes.length, 2);
    repository.close();
});
// Arcoverde: zona Praia (11) com A1 e A2 livres e A3 ocupado; A9 livre na zona Centro (10).
function createArcoverdeQueue() {
    const gateway = new DemoAutocabClient();
    let statuses = [
        { vehicleId: 301, zoneId: 11, queuePosition: 1, status: 'Available', hasPenalty: false },
        { vehicleId: 302, zoneId: 11, queuePosition: 2, status: 'Available', hasPenalty: false },
        { vehicleId: 303, zoneId: 11, queuePosition: 3, status: 'BusyMeterOn', hasPenalty: false },
        { vehicleId: 309, zoneId: 10, queuePosition: 1, status: 'Available', hasPenalty: false },
    ];
    gateway.listZones = async () => [{ id: 10, name: 'Centro', companyId: 1 }, { id: 11, name: 'Praia', companyId: 1 }];
    gateway.listVehicles = async () => [{ id: 301, callsign: 'A1', companyId: 1 }, { id: 302, callsign: 'A2', companyId: 1 }, { id: 303, callsign: 'A3', companyId: 1 }, { id: 309, callsign: 'A9', companyId: 1 }];
    gateway.listVehicleStatuses = async () => structuredClone(statuses);
    gateway.listGpsPositions = async () => [];
    const setStatuses = (next: typeof statuses) => { statuses = next; };
    return { gateway, setStatuses, statuses: () => statuses };
}
test('Arcoverde avisa só os motoristas livres da zona cuja fila mudou, com a ordem da fila', async () => {
    const { gateway, setStatuses, statuses } = createArcoverdeQueue();
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, 'live', 'live');
    const connection = { id: 'arcoverde', name: 'Arcoverde', companyId: 1, companyName: 'Arcoverde', driverMessages: true, gateway };
    await service.runConnection(connection);
    assert.equal(gateway.sentMessages.length, 0, 'primeira leitura só guarda a fila');
    // A2 passa à frente de A1 na Praia; Centro não muda.
    setStatuses(statuses().map(status => status.vehicleId === 301 ? { ...status, queuePosition: 2 } : status.vehicleId === 302 ? { ...status, queuePosition: 1 } : status));
    await service.runConnection(connection);
    assert.deepEqual(gateway.sentMessages.map(message => message.vehicleId).sort(), [301, 302]);
    const toA1 = gateway.sentMessages.find(message => message.vehicleId === 301)!.message;
    assert.match(toA1, /ARCOVERDE - Fila Praia atualizada\. Você é o 2º\. 1º A2 \| 2º A1$/);
    assert.ok(!toA1.includes('A3'), 'ocupado não aparece na fila');
    const logged = repository.getDashboard().messages ?? [];
    assert.equal(logged.length, 2);
    assert.ok(logged.every(message => message.outcome === 'sent' && message.zoneName === 'Praia'));
    await service.runConnection(connection);
    assert.equal(gateway.sentMessages.length, 2, 'fila igual não repete a mensagem');
    repository.close();
});
test('avisos em dry ficam só registrados e outras empresas não recebem', async () => {
    const { gateway, setStatuses, statuses } = createArcoverdeQueue();
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, 'dry', 'dry');
    const arcoverde = { id: 'arcoverde', name: 'Arcoverde', companyId: 1, driverMessages: true, gateway };
    const saoConrado = { id: 'sao-conrado', name: 'São Conrado', companyId: 1, gateway };
    await service.runConnection(arcoverde);
    await service.runConnection(saoConrado);
    setStatuses(statuses().filter(status => status.vehicleId !== 301));
    await service.runConnection(arcoverde);
    await service.runConnection(saoConrado);
    assert.equal(gateway.sentMessages.length, 0);
    const logged = repository.getDashboard().messages ?? [];
    assert.deepEqual(logged.map(message => [message.connectionId, message.callsign, message.outcome]), [['arcoverde', 'A2', 'simulated']]);
    assert.match(logged[0].message, /Você é o 1º\. 1º A2$/);
    repository.close();
});
test('em teste só o motorista 5013 recebe, com a fila completa, mesmo com correções em dry', async () => {
    const { gateway, setStatuses, statuses } = createArcoverdeQueue();
    const baseVehicles = await gateway.listVehicles();
    gateway.listVehicles = async () => baseVehicles.map(vehicle => vehicle.id === 302 ? { ...vehicle, callsign: '5013' } : vehicle);
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, 'dry', 'live', ['5013']);
    const connection = { id: 'arcoverde', name: 'Arcoverde', companyId: 1, driverMessages: true, gateway };
    await service.runConnection(connection);
    setStatuses(statuses().map(status => status.vehicleId === 301 ? { ...status, queuePosition: 2 } : status.vehicleId === 302 ? { ...status, queuePosition: 1 } : status));
    await service.runConnection(connection);
    assert.deepEqual(gateway.sentMessages, [{ vehicleId: 302, message: 'ARCOVERDE - Fila Praia atualizada. Você é o 1º. 1º 5013 | 2º A1' }]);
    assert.equal((repository.getDashboard().messages ?? []).length, 1);
    repository.close();
});
test('DRIVER_MESSAGES_ONLY usa 5013 por padrão e * libera para todos', () => {
    const previous = process.env.DRIVER_MESSAGES_ONLY;
    try {
        delete process.env.DRIVER_MESSAGES_ONLY;
        assert.deepEqual(readConfiguration().driverMessageRecipients, ['5013']);
        process.env.DRIVER_MESSAGES_ONLY = '*';
        assert.equal(readConfiguration().driverMessageRecipients, null);
        process.env.DRIVER_MESSAGES_ONLY = '5013, 4020';
        assert.deepEqual(readConfiguration().driverMessageRecipients, ['5013', '4020']);
    }
    finally {
        if (previous === undefined) delete process.env.DRIVER_MESSAGES_ONLY;
        else process.env.DRIVER_MESSAGES_ONLY = previous;
    }
});
test('mensagem ao motorista usa Send Message to Vehicle(s) da Vehicle API', async () => {
    let request: { path: string; method?: string; body: unknown } | null = null;
    const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
        request = { path: new URL(String(input)).pathname, method: init?.method, body: JSON.parse(String(init?.body)) };
        return Response.json({ messagesQueued: false, vehicles: { workingVehicles: [], nonWorkingVehicles: [5013] } });
    }) as typeof fetch;
    const client = new AutocabClient('https://autocab-api.azure-api.net', 'key', fakeFetch);
    assert.equal(await client.sendDriverMessage(5013, 'fila'), 200);
    assert.deepEqual(request, { path: '/vehicle/v1/vehicles/message', method: 'POST', body: { text: 'fila', vehicles: [5013], companies: [], capabilities: [], zones: [], urgent: true } });
});
test('campos de urgência da mensagem podem ser trocados por AUTOCAB_DRIVER_MESSAGE_FIELDS', () => {
    const previous = process.env.AUTOCAB_DRIVER_MESSAGE_FIELDS;
    try {
        delete process.env.AUTOCAB_DRIVER_MESSAGE_FIELDS;
        assert.deepEqual(readConfiguration().driverMessageFields, { urgent: true });
        process.env.AUTOCAB_DRIVER_MESSAGE_FIELDS = '{"isUrgent":true,"messageType":"Urgent"}';
        assert.deepEqual(readConfiguration().driverMessageFields, { isUrgent: true, messageType: 'Urgent' });
        process.env.AUTOCAB_DRIVER_MESSAGE_FIELDS = '[1]';
        assert.throws(() => readConfiguration(), /objeto JSON/);
    }
    finally {
        if (previous === undefined) delete process.env.AUTOCAB_DRIVER_MESSAGE_FIELDS;
        else process.env.AUTOCAB_DRIVER_MESSAGE_FIELDS = previous;
    }
});
