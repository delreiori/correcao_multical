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
test('com DRIVER_MESSAGES_ONLY=5013 só ele recebe, com a fila completa, mesmo com correções em dry', async () => {
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
test('avisos vão para todos por padrão e DRIVER_MESSAGES_ONLY restringe', () => {
    const previous = process.env.DRIVER_MESSAGES_ONLY;
    try {
        delete process.env.DRIVER_MESSAGES_ONLY;
        assert.equal(readConfiguration().driverMessageRecipients, null);
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
test('avisa todos que já estavam na fila e mudaram de posição; quem entra não é avisado nem registrado', async () => {
    const gateway = new DemoAutocabClient();
    const ids = Array.from({ length: 9 }, (_, index) => 401 + index);
    let order = [...ids];
    gateway.listZones = async () => [{ id: 11, name: 'Praia', companyId: 1 }];
    gateway.listVehicles = async () => [...ids, 499].map(id => ({ id, callsign: 'C' + id, companyId: 1 }));
    gateway.listVehicleStatuses = async () => order.map((vehicleId, index) => ({ vehicleId, zoneId: 11, queuePosition: index + 1, status: 'Available', hasPenalty: false }));
    gateway.listGpsPositions = async () => [];
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, 'live', 'live');
    const connection = { id: 'arcoverde', name: 'Arcoverde', companyId: 1, driverMessages: true, gateway };
    await service.runConnection(connection);
    // Um carro novo entra no fim da fila: ninguém mudou de posição e o novo não é avisado.
    order = [...ids, 499];
    await service.runConnection(connection);
    assert.equal(gateway.sentMessages.length, 0);
    assert.equal((repository.getDashboard().messages ?? []).length, 0);
    // O 8º e o 9º trocam: só os dois recebem, mesmo fora dos 7 primeiros.
    order = [...ids.slice(0, 7), ids[8], ids[7], 499];
    await service.runConnection(connection);
    assert.deepEqual(gateway.sentMessages.map(message => message.vehicleId).sort(), [408, 409]);
    assert.match(gateway.sentMessages.find(message => message.vehicleId === 409)!.message, /Você é o 8º\. 1º C401 \| .* \| 7º C407 \| \+3$/);
    // O 1º sai da zona: todos os que ficaram sobem e recebem, inclusive o último que entrou.
    gateway.sentMessages.length = 0;
    order = order.slice(1);
    await service.runConnection(connection);
    assert.equal(gateway.sentMessages.length, 9);
    repository.close();
});
test('DRIVER_MESSAGES_TOP é opcional e limita o aviso aos primeiros da fila', () => {
    const previous = process.env.DRIVER_MESSAGES_TOP;
    try {
        delete process.env.DRIVER_MESSAGES_TOP;
        assert.equal(readConfiguration().driverMessagesTop, null);
        process.env.DRIVER_MESSAGES_TOP = '7';
        assert.equal(readConfiguration().driverMessagesTop, 7);
    }
    finally {
        if (previous === undefined) delete process.env.DRIVER_MESSAGES_TOP;
        else process.env.DRIVER_MESSAGES_TOP = previous;
    }
});
test('modo demo aplica as mudanças na frota fictícia em vez de ignorá-las', async () => {
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, 'demo');
    await service.runConnection({ id: 'demo', name: 'Demo', gateway: new DemoAutocabClient() });
    const changes = repository.getDashboard().changes;
    assert.equal(changes.length, 2);
    assert.ok(changes.every(change => change.outcome === 'confirmed'));
    repository.close();
});
test('avisos de zonas diferentes saem juntos, sem uma zona esperar a outra', async () => {
    const gateway = new DemoAutocabClient();
    let swapped = false;
    gateway.listZones = async () => [{ id: 11, name: 'Praia', companyId: 1 }, { id: 12, name: 'Centro', companyId: 1 }];
    gateway.listVehicles = async () => [501, 502, 601, 602].map(id => ({ id, callsign: 'V' + id, companyId: 1 }));
    gateway.listVehicleStatuses = async () => [
        { vehicleId: swapped ? 502 : 501, zoneId: 11, queuePosition: 1, status: 'Available', hasPenalty: false },
        { vehicleId: swapped ? 501 : 502, zoneId: 11, queuePosition: 2, status: 'Available', hasPenalty: false },
        { vehicleId: swapped ? 602 : 601, zoneId: 12, queuePosition: 1, status: 'Available', hasPenalty: false },
        { vehicleId: swapped ? 601 : 602, zoneId: 12, queuePosition: 2, status: 'Available', hasPenalty: false },
    ];
    gateway.listGpsPositions = async () => [];
    let inFlight = 0, maxInFlight = 0;
    gateway.sendDriverMessage = async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise(resolve => setTimeout(resolve, 20)); inFlight--; return 200; };
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, 'dry', 'live');
    const connection = { id: 'arcoverde', name: 'Arcoverde', companyId: 1, driverMessages: true, gateway };
    await service.runConnection(connection);
    swapped = true;
    await service.runConnection(connection);
    assert.equal(maxInFlight, 4);
    assert.equal((repository.getDashboard().messages ?? []).length, 4);
    repository.close();
});
test('conferência de fila usa 2 s e passada rápida 5 s por padrão; ambas aceitam 0', async () => {
    const { readQueuePollIntervalMs, readFastPassIntervalMs } = await import('../server/execution-limits.ts');
    assert.equal(readQueuePollIntervalMs(undefined), 2000);
    assert.equal(readQueuePollIntervalMs('0'), 0);
    assert.equal(readQueuePollIntervalMs('x'), 2000);
    assert.equal(readFastPassIntervalMs(undefined), 5000);
    assert.equal(readFastPassIntervalMs('0'), 0);
});
// Arcoverde com ocupado de rua: 701 ocupado em PA1 pos. 1, 702 e 703 livres atrás; zona Centro (12) vazia.
function createBusyStreetRide(busyGpsZone: number) {
    const gateway = new DemoAutocabClient();
    let statuses = [
        { vehicleId: 701, zoneId: 11, queuePosition: 1, status: 'BusyStreetHail', hasPenalty: false },
        { vehicleId: 702, zoneId: 11, queuePosition: 2, status: 'Available', hasPenalty: false },
        { vehicleId: 703, zoneId: 11, queuePosition: 3, status: 'Available', hasPenalty: false },
    ];
    gateway.listZones = async () => [{ id: 11, name: 'PA1', companyId: 1 }, { id: 12, name: 'Centro', companyId: 1 }];
    gateway.listVehicles = async () => [701, 702, 703].map(id => ({ id, callsign: String(id), companyId: 1 }));
    gateway.listVehicleStatuses = async () => structuredClone(statuses);
    gateway.listGpsPositions = async () => [{ vehicleId: 701, latitude: -22.95, longitude: -43.18 }, { vehicleId: 702, latitude: -22.9, longitude: -43.2 }, { vehicleId: 703, latitude: -22.9, longitude: -43.2 }];
    gateway.findZoneByCoordinates = async (latitude: number) => latitude === -22.95 ? busyGpsZone : 11;
    gateway.applyVehiclePlot = async (vehicleId: number, zoneId: number, position: number) => {
        statuses = statuses.map(status => status.vehicleId === vehicleId ? { ...status, zoneId, queuePosition: position } : status);
        return 200;
    };
    return { gateway, setStatuses: (next: typeof statuses) => { statuses = next; }, statuses: () => statuses };
}
test('Arcoverde: ocupado de rua acompanha a zona do GPS e vai para o fim da fila', async () => {
    const { gateway } = createBusyStreetRide(12);
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, 'live');
    await service.runConnection({ id: 'arcoverde', name: 'Arcoverde', companyId: 1, busyFollowsGps: true, gateway });
    const changes = repository.getDashboard().changes;
    assert.deepEqual(changes.map(change => [change.vehicleId, change.previousZoneName, change.targetZoneName, change.reason, change.outcome]), [[701, 'PA1', 'Centro', 'busy-gps', 'confirmed']]);
    repository.close();
});
test('Arcoverde: ocupado de rua na mesma zona não segura a posição à frente dos livres', async () => {
    const { gateway, setStatuses, statuses } = createBusyStreetRide(11);
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, 'live');
    const connection = { id: 'arcoverde', name: 'Arcoverde', companyId: 1, busyFollowsGps: true, gateway };
    await service.runConnection(connection);
    const [change] = repository.getDashboard().changes;
    assert.equal(change.vehicleId, 701);
    assert.equal(change.targetZoneName, 'PA1');
    assert.equal(change.position, 4, 'vai para depois do último da fila');
    // Já atrás de todos os livres: não mexe mais.
    assert.equal(statuses().find(status => status.vehicleId === 701)?.queuePosition, 4);
    await service.runConnection(connection);
    assert.equal(repository.getDashboard().changes.length, 1);
    // Se a Autocab não aplicar a posição, não insiste a cada passada (no máximo 1x por minuto).
    setStatuses(statuses().map(status => status.vehicleId === 701 ? { ...status, queuePosition: 1 } : status));
    await service.runConnection(connection);
    assert.equal(repository.getDashboard().changes.length, 1);
    repository.close();
});
test('sem a regra (outras empresas) o ocupado não acompanha o GPS', async () => {
    const { gateway } = createBusyStreetRide(12);
    let lookups = 0;
    const lookup = gateway.findZoneByCoordinates.bind(gateway);
    gateway.findZoneByCoordinates = async (...args) => { lookups++; return lookup(...args); };
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, 'live');
    await service.runConnection({ id: 'sao-conrado', name: 'São Conrado', companyId: 1, gateway });
    assert.ok(!repository.getDashboard().changes.some(change => change.vehicleId === 701));
    assert.equal(lookups, 2, 'GPS só dos livres');
    repository.close();
});
test('configuração padrão: nenhuma empresa usa ocupado acompanhando o GPS (ocupado vai para FORA DE AREA)', () => {
    const { connections } = readConfiguration();
    assert.ok(connections.every(connection => !connection.busyFollowsGps));
});
test('Arcoverde: ocupado vai para FORA DE AREA, fica lá enquanto ocupado e só sai quando fica livre', async () => {
    const gateway = new DemoAutocabClient();
    let gpsZone = 12;
    let statuses = [
        { vehicleId: 801, zoneId: 11, queuePosition: 1, status: 'BusyStreetHail', hasPenalty: false },
        { vehicleId: 802, zoneId: 11, queuePosition: 2, status: 'Available', hasPenalty: false },
    ];
    gateway.listZones = async () => [{ id: 11, name: 'PA1', companyId: 1 }, { id: 12, name: 'Centro', companyId: 1 }, { id: 13, name: 'Fora de Área', companyId: 1 }];
    gateway.listVehicles = async () => [801, 802].map(id => ({ id, callsign: String(id), companyId: 1 }));
    gateway.listVehicleStatuses = async () => structuredClone(statuses);
    gateway.listGpsPositions = async () => [{ vehicleId: 801, latitude: -22.95, longitude: -43.18 }, { vehicleId: 802, latitude: -22.9, longitude: -43.2 }];
    gateway.findZoneByCoordinates = async (latitude: number) => latitude === -22.95 ? gpsZone : 11;
    gateway.applyVehiclePlot = async (vehicleId: number, zoneId: number, position: number) => {
        statuses = statuses.map(status => status.vehicleId === vehicleId ? { ...status, zoneId, queuePosition: position } : status);
        return 200;
    };
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, rules, 'live');
    const arcoverde = readConfiguration().connections.find(connection => connection.id === 'arcoverde')!;
    const connection = { id: arcoverde.id, name: arcoverde.name, companyId: 1, driverMessages: arcoverde.driverMessages, busyFollowsGps: arcoverde.busyFollowsGps, gateway };
    await service.runConnection(connection);
    assert.equal(statuses.find(status => status.vehicleId === 801)?.zoneId, 13, 'ocupado foi para FORA DE AREA');
    // Continua ocupado e andando: não sai de FORA DE AREA.
    gpsZone = 11;
    await service.runConnection(connection);
    assert.equal(statuses.find(status => status.vehicleId === 801)?.zoneId, 13);
    // Ficou livre: volta para a zona do GPS.
    statuses = statuses.map(status => status.vehicleId === 801 ? { ...status, status: 'Available' } : status);
    gpsZone = 12;
    await service.runConnection(connection);
    assert.equal(statuses.find(status => status.vehicleId === 801)?.zoneId, 12, 'livre saiu de FORA DE AREA para a zona do GPS');
    assert.deepEqual(repository.getDashboard().changes.map(change => change.reason).reverse(), ['busy-outside', 'gps']);
    repository.close();
});
test('zona de fora de área aceita "FORA D AREA" (Arcoverde) e "FORA DE AREA"', async () => {
    const { findOutsideZone, isProtectedZone } = await import('../server/rules.ts');
    const configuration = readConfiguration();
    const arcoverde = findOutsideZone([{ id: 1, name: 'PA1', companyId: 1 }, { id: 2, name: 'FORA D AREA', companyId: 1 }], configuration);
    assert.equal(arcoverde?.id, 2);
    const other = findOutsideZone([{ id: 3, name: 'Fora de Área', companyId: 2 }], configuration);
    assert.equal(other?.id, 3);
    assert.ok(isProtectedZone({ id: 2, name: 'FORA D AREA', companyId: 1 }, configuration));
    assert.throws(() => findOutsideZone([{ id: 2, name: 'FORA D AREA', companyId: 1 }, { id: 3, name: 'FORA DE AREA', companyId: 1 }], configuration), /ambígua/);
});
test('qualquer ocupação conta como ocupado; só Clear é livre e fora de serviço não é ocupado', async () => {
    const { isBusy, isAvailable, summarizeStatuses } = await import('../server/rules.ts');
    const status = (name: string, extra: object = {}) => ({ vehicleId: 1, zoneId: 1, queuePosition: 1, status: name, hasPenalty: false, ...extra });
    for (const name of ['BusyMeterOnFromClear', 'BusyMeterOff', 'BusyMeterOnFromMeterOffCash', 'StreetPickup', 'PickedUp', 'MeterOn', 'Dispatched', 'JobOffered', 'SoonToClear', 'Ocupado (Corrida de Rua)', 'QualquerOutroStatus'])
        assert.ok(isBusy(status(name)), name);
    for (const name of ['Clear', 'Available', 'Livre'])
        assert.ok(!isBusy(status(name)) && isAvailable(status(name)), name);
    const { isNotFree, isBusyFor } = await import('../server/rules.ts');
    for (const name of ['NotWorking', 'OnBreak', 'Suspended']) {
        assert.ok(!isBusy(status(name)) && !isAvailable(status(name)), `${name}: regra padrão não conta como ocupado`);
        assert.ok(isNotFree(status(name)) && isBusyFor(status(name), { protectedZoneNames: [], outsideZoneName: '', allNotFreeToOutside: true }), `${name}: na Arcoverde vai para fora de área`);
    }
    assert.ok(isBusy(status('Clear', { atPickup: true })), 'indo buscar passageiro');
    assert.ok(isBusy(status('Clear', { dispatchInProgress: true })), 'despacho em andamento');
    const previous = { free: process.env.FREE_STATUSES, busy: process.env.BUSY_STATUSES };
    try {
        process.env.FREE_STATUSES = 'Waiting';
        process.env.BUSY_STATUSES = 'Clear';
        assert.ok(!isBusy(status('waiting')));
        assert.ok(isBusy(status('Clear')));
    } finally {
        for (const [name, value] of [['FREE_STATUSES', previous.free], ['BUSY_STATUSES', previous.busy]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
    assert.equal(summarizeStatuses([status('Clear'), status('Clear'), status('StreetPickup')]), 'Clear 2, StreetPickup 1 (ocupado)');
});
test('ocupados que já estão na fila hoje também vão para FORA D AREA', async () => {
    const gateway = new DemoAutocabClient();
    let statuses = [
        { vehicleId: 901, zoneId: 11, queuePosition: 1, status: 'JobOffered', hasPenalty: false },
        { vehicleId: 902, zoneId: 11, queuePosition: 2, status: 'Clear', hasPenalty: false, atPickup: true },
        { vehicleId: 903, zoneId: 11, queuePosition: 3, status: 'Clear', hasPenalty: false },
    ];
    gateway.listZones = async () => [{ id: 11, name: 'PA1', companyId: 1 }, { id: 13, name: 'FORA D AREA', companyId: 1 }];
    gateway.listVehicles = async () => [901, 902, 903].map(id => ({ id, callsign: String(id), companyId: 1 }));
    gateway.listVehicleStatuses = async () => structuredClone(statuses);
    gateway.listGpsPositions = async () => [];
    gateway.applyVehiclePlot = async (vehicleId: number, zoneId: number, position: number) => {
        statuses = statuses.map(item => item.vehicleId === vehicleId ? { ...item, zoneId, queuePosition: position } : item);
        return 200;
    };
    const repository = new AuditRepository(':memory:');
    await new CorrectionService(repository, readConfiguration(), 'live').runConnection({ id: 'arcoverde', name: 'Arcoverde', companyId: 1, gateway });
    assert.deepEqual(statuses.map(item => [item.vehicleId, item.zoneId]), [[901, 13], [902, 13], [903, 11]]);
    repository.close();
});
test('envio sem confirmação trava o carro só por 2 minutos e o detalhe mostra por que o ocupado não moveu', async (context) => {
    const gateway = new DemoAutocabClient();
    let statuses = [
        { vehicleId: 951, zoneId: 11, queuePosition: 1, status: 'BusyMeterOnFromClear', hasPenalty: false },
        { vehicleId: 952, zoneId: 11, queuePosition: 2, status: 'BusyMeterOff', hasPenalty: true },
    ];
    gateway.listZones = async () => [{ id: 11, name: 'GAVEA', companyId: 1 }, { id: 13, name: 'FORA D AREA', companyId: 1 }];
    gateway.listVehicles = async () => [{ id: 951, callsign: '5036', companyId: 1 }, { id: 952, callsign: '5012', companyId: 1 }];
    gateway.listVehicleStatuses = async () => structuredClone(statuses);
    gateway.listGpsPositions = async () => [];
    let applyForReal = false;
    gateway.applyVehiclePlot = async (vehicleId: number, zoneId: number, position: number) => {
        if (applyForReal)
            statuses = statuses.map(item => item.vehicleId === vehicleId ? { ...item, zoneId, queuePosition: position } : item);
        return 200;
    };
    let now = Date.now();
    context.mock.method(Date, 'now', () => now);
    const repository = new AuditRepository(':memory:');
    const service = new CorrectionService(repository, readConfiguration(), 'live');
    const connection = { id: 'arcoverde', name: 'Arcoverde', companyId: 1, gateway };
    // A Autocab aceita mas não aplica: fica "não confirmada" e o carro trava.
    await service.runConnection(connection);
    assert.equal(repository.getDashboard().changes[0].outcome, 'unconfirmed');
    await service.runConnection(connection);
    assert.match(repository.getDashboard().cycles[0].detail ?? '', /ocupados sem mover: 5036 \(aguardando confirmação de envio anterior\), 5012 \(com penalidade\)/);
    // Passados 2 minutos sem confirmação, o carro é liberado e o envio é refeito.
    now += 121_000;
    applyForReal = true;
    await service.runConnection(connection);
    assert.equal(statuses.find(item => item.vehicleId === 951)?.zoneId, 13);
    const changes = repository.getDashboard().changes;
    assert.deepEqual(changes.map(change => change.outcome), ['confirmed', 'failed']);
    repository.close();
});
test('Arcoverde: todos que não estão livres vão para FORA D AREA, menos NAK e sem sinal de GPS; outras empresas seguem a regra padrão', async () => {
    const gateway = new DemoAutocabClient();
    let statuses = [
        { vehicleId: 1, zoneId: 11, queuePosition: 1, status: 'BusyMeterOnFromClear', hasPenalty: false },
        { vehicleId: 2, zoneId: 11, queuePosition: 2, status: 'NotWorking', hasPenalty: false },
        { vehicleId: 3, zoneId: 11, queuePosition: 3, status: 'Clear', hasPenalty: false },
        { vehicleId: 4, zoneId: 14, queuePosition: 1, status: 'BusyMeterOff', hasPenalty: false },
        { vehicleId: 5, zoneId: 15, queuePosition: 1, status: 'BusyMeterOff', hasPenalty: false },
        { vehicleId: 6, zoneId: 11, queuePosition: 4, status: 'NoGps', hasPenalty: false },
        { vehicleId: 7, zoneId: 11, queuePosition: 5, status: 'NAK', hasPenalty: false },
    ];
    gateway.listZones = async () => [{ id: 11, name: 'GAVEA', companyId: 1 }, { id: 13, name: 'FORA D AREA', companyId: 1 }, { id: 14, name: 'NAK', companyId: 1 }, { id: 15, name: 'S/GPS', companyId: 1 }];
    gateway.listVehicles = async () => statuses.map(item => ({ id: item.vehicleId, callsign: String(5000 + item.vehicleId), companyId: 1 }));
    gateway.listVehicleStatuses = async () => structuredClone(statuses);
    gateway.listGpsPositions = async () => [];
    gateway.applyVehiclePlot = async (vehicleId: number, zoneId: number, position: number) => {
        statuses = statuses.map(item => item.vehicleId === vehicleId ? { ...item, zoneId, queuePosition: position } : item);
        return 200;
    };
    const repository = new AuditRepository(':memory:');
    const initial = structuredClone(statuses);
    const arcoverde = readConfiguration().connections.find(connection => connection.id === 'arcoverde')!;
    assert.equal(arcoverde.allNotFreeToOutside, true);
    await new CorrectionService(repository, readConfiguration(), 'live').runConnection({ id: 'arcoverde', name: 'Arcoverde', companyId: 1, allNotFreeToOutside: arcoverde.allNotFreeToOutside, gateway });
    assert.deepEqual(statuses.map(item => [item.vehicleId, item.zoneId]), [[1, 13], [2, 13], [3, 11], [4, 14], [5, 15], [6, 11], [7, 11]]);
    // Outra empresa (sem a regra): fora de serviço fica na zona e S/GPS não é protegida.
    const saoConrado = readConfiguration().connections.find(connection => connection.id === 'sao-conrado')!;
    assert.ok(!saoConrado.allNotFreeToOutside);
    statuses = initial;
    const otherRepository = new AuditRepository(':memory:');
    await new CorrectionService(otherRepository, readConfiguration(), 'live').runConnection({ id: 'sao-conrado', name: 'São Conrado', companyId: 1, gateway });
    assert.deepEqual(statuses.map(item => [item.vehicleId, item.zoneId]), [[1, 13], [2, 11], [3, 11], [4, 14], [5, 13], [6, 13], [7, 13]]);
    otherRepository.close();
    assert.match(repository.getDashboard().cycles[0].detail ?? '', /ocupados sem mover: .*5004 \(zona protegida NAK\).*5005 \(zona protegida S\/GPS\).*5006 \(status NoGps\).*5007 \(status NAK\)/);
    repository.close();
});
test('carro em zona da Arcoverde com cadastro sem empresa ou de outra empresa também vai para FORA D AREA', async () => {
    const gateway = new DemoAutocabClient();
    let statuses = [
        { vehicleId: 16, zoneId: 11, queuePosition: 1, status: 'BusyMeterOnFromClear', hasPenalty: false },
        { vehicleId: 28, zoneId: 11, queuePosition: 2, status: 'BusyMeterOff', hasPenalty: false },
        { vehicleId: 99, zoneId: 21, queuePosition: 1, status: 'BusyMeterOff', hasPenalty: false },
    ];
    gateway.listZones = async () => [{ id: 11, name: 'CAJU', companyId: 1 }, { id: 13, name: 'FORA D AREA', companyId: 1 }, { id: 21, name: 'SC CENTRO', companyId: 2 }];
    (gateway as { listVehicles: () => Promise<{ id: number; callsign: string; companyId: number | null }[]> }).listVehicles = async () => [{ id: 16, callsign: '5016', companyId: null }, { id: 28, callsign: '5028', companyId: 9 }, { id: 99, callsign: '6099', companyId: 9 }];
    gateway.listVehicleStatuses = async () => structuredClone(statuses);
    gateway.listGpsPositions = async () => [];
    gateway.applyVehiclePlot = async (vehicleId: number, zoneId: number, position: number) => {
        statuses = statuses.map(item => item.vehicleId === vehicleId ? { ...item, zoneId, queuePosition: position } : item);
        return 200;
    };
    const repository = new AuditRepository(':memory:');
    await new CorrectionService(repository, readConfiguration(), 'live').runConnection({ id: 'arcoverde', name: 'Arcoverde', companyId: 1, allNotFreeToOutside: true, gateway });
    assert.deepEqual(statuses.map(item => [item.vehicleId, item.zoneId]), [[16, 13], [28, 13], [99, 21]], 'carro em zona de outra empresa não é mexido');
    assert.match(repository.getDashboard().cycles[0].detail ?? '', /incluídos por estarem em zona da empresa: 5016 \(sem empresa\), 5028 \(empresa 9\)/);
    repository.close();
});
