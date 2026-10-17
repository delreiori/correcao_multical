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
