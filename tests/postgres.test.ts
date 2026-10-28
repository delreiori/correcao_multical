import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { PostgresAuditRepository } from '../server/postgres-repository.ts';
import { postgresSchema } from '../server/postgres-schema.ts';
import { CorrectionService } from '../server/correction-service.ts';
import { DemoAutocabClient } from '../server/demo.ts';
import { NeonCycleRunner, CycleAlreadyRunningError } from '../server/neon-runtime.ts';
import { createServerlessHandler } from '../server/serverless-handler.ts';
import type { AppConfig } from '../server/config.ts';
const rules = { protectedZoneNames: ['NAK', 'FORA DE AREA'], outsideZoneName: 'FORA DE AREA' };
async function createDatabase() {
    const database = new PGlite();
    const repository = new PostgresAuditRepository({ query: async (sql, parameters) => {
            if (sql === postgresSchema) {
                await database.exec(sql);
                return { rows: [] };
            }
            const result = await database.query<Record<string, unknown>>(sql, parameters);
            return { rows: result.rows };
        } });
    await repository.initialize();
    return { database, repository };
}
test('PostgreSQL grava ciclos/JSONB/zonas e preserva isolamento por conexão', async () => {
    const { database, repository } = await createDatabase();
    try {
        const gateway = new DemoAutocabClient();
        const service = new CorrectionService(repository, rules, 'dry');
        await service.runConnection({ id: 'empresa-a', name: 'A', gateway });
        await service.runConnection({ id: 'empresa-b', name: 'B', gateway });
        const dashboard = await repository.getDashboard('empresa-a');
        assert.equal(dashboard.changes.length, 2);
        assert.equal(dashboard.cycles[0].outcome, 'completed');
        assert.equal(dashboard.zones.length, 4);
        assert.equal(typeof dashboard.changes[0].vehicleId, 'number');
        assert.equal(typeof dashboard.zones[0].id, 'number');
        assert.equal(dashboard.totalChanges, 2);
        await repository.saveZones('empresa-a', [{ id: 1, name: 'Centro atualizado', companyId: null }]);
        assert.deepEqual((await repository.getDashboard('empresa-a')).zones.map(zone => zone.name), ['Centro atualizado']);
        assert.equal((await repository.getDashboard('empresa-b')).zones.length, 4);
    }
    finally {
        await database.close();
    }
});
test('lease PostgreSQL exclui concorrência, permite expiração e rejeita liberação por dono antigo', async () => {
    const { database, repository } = await createDatabase();
    try {
        const claims = await Promise.all([repository.acquireCycleLease('first'), repository.acquireCycleLease('second')]);
        assert.equal(claims.filter(Boolean).length, 1);
        const previousOwner = claims[0] ? 'first' : 'second';
        await database.query('UPDATE correction_lock SET "expiresAt"=now()-interval \'1 second\'');
        assert.equal(await repository.acquireCycleLease('new-owner'), true);
        await repository.releaseCycleLease(previousOwner);
        assert.equal(await repository.acquireCycleLease('intruder'), false);
        await repository.releaseCycleLease('new-owner');
        assert.equal(await repository.acquireCycleLease('next'), true);
    }
    finally {
        await database.close();
    }
});
test('dois executores serverless compartilham bloqueio no banco', async () => {
    const { database, repository } = await createDatabase();
    try {
        const service = new CorrectionService(repository, rules, 'dry');
        const runner = new NeonCycleRunner(repository, service, []);
        await repository.acquireCycleLease('other-instance');
        await assert.rejects(runner.runOnce(), CycleAlreadyRunningError);
        await repository.releaseCycleLease('other-instance');
        await runner.runOnce();
        assert.equal(await repository.acquireCycleLease('after-run'), true);
    }
    finally {
        await database.close();
    }
});
test('executor verifica e corrige toda a frota com mais de dez veículos', async () => {
    const { database, repository } = await createDatabase();
    try {
        const statuses = Array.from({ length: 35 }, (_, index) => ({ vehicleId: 1000 + index, zoneId: 1, queuePosition: index + 1, status: 'Available', hasPenalty: false }));
        const gateway = new DemoAutocabClient();
        gateway.listVehicleStatuses = async () => structuredClone(statuses);
        gateway.listVehicles = async () => statuses.map(status => ({ id: status.vehicleId, callsign: String(status.vehicleId), companyId: 1 }));
        gateway.listGpsPositions = async () => statuses.map(status => ({ vehicleId: status.vehicleId, latitude: -23.5, longitude: -46.6 }));
        const sentVehicles: number[] = [];
        gateway.applyVehiclePlot = async (vehicleId, zoneId, position) => {
            const status = statuses.find(status => status.vehicleId === vehicleId)!;
            status.zoneId = zoneId; status.queuePosition = position; sentVehicles.push(vehicleId); return 200;
        };
        const service = new CorrectionService(repository, rules, 'live');
        const runner = new NeonCycleRunner(repository, service, [{ id: 'main', name: 'Main', gateway }]);
        await runner.runOnce();
        const dashboard = await repository.getDashboard('main');
        assert.equal(dashboard.cycles[0].inspected, 35);
        assert.equal(dashboard.cycles[0].outcome, 'completed');
        assert.equal(dashboard.changes.length, 35);
        assert.ok(dashboard.changes.every(change => change.outcome === 'confirmed'));
        assert.equal(new Set(sentVehicles).size, 35);
    } finally { await database.close(); }
});
test('limite de tempo preserva o cursor e retoma a frota no ciclo seguinte', async (context) => {
    const { database, repository } = await createDatabase();
    try {
        const gateway = new DemoAutocabClient();
        let currentTime = Date.now();
        context.mock.method(Date, 'now', () => currentTime);
        gateway.findZoneByCoordinates = async () => { currentTime += 20000; return 2; };
        const service = new CorrectionService(repository, rules, 'dry');
        const connection = { id: 'main', name: 'Main', gateway };
        await service.runConnection(connection, { deadline: currentTime + 30000 });
        const partialCycle = (await repository.getDashboard()).cycles[0];
        assert.equal(partialCycle.outcome, 'partial');
        // O lote de consultas GPS roda em paralelo; o tempo esgota no envio e o cursor volta antes do veículo pendente.
        assert.equal(partialCycle.inspected, 4);
        assert.equal(await repository.getVehicleCursor('main'), 100);
        await service.runConnection(connection);
        const dashboard = await repository.getDashboard();
        assert.ok(dashboard.cycles.some(cycle => cycle.outcome === 'completed' && cycle.inspected === 4));
        assert.equal(dashboard.changes.length, 2);
    } finally { await database.close(); }
});
test('histórico pendente vira incerto e confirmação posterior é gravada no PostgreSQL', async () => {
    const { database, repository } = await createDatabase();
    try {
        const cycleId = await repository.startCycle('main', 'live');
        const changeId = await repository.createChange('main', cycleId, 'live', { vehicleId: 101, callsign: '101', previousZoneId: 1, previousZoneName: 'Centro', targetZoneId: 2, targetZoneName: 'Estação', position: 2, reason: 'gps', latitude: null, longitude: null }, 'pending');
        await repository.recoverInterruptedCycles();
        assert.equal((await repository.listUnresolvedChanges('main'))[0].outcome, 'unknown');
        await repository.finishChange(changeId, 'confirmed', 200);
        assert.equal((await repository.listUnresolvedChanges('main')).length, 0);
        assert.equal((await repository.getDashboard()).changes[0].httpStatus, 200);
    }
    finally {
        await database.close();
    }
});
test('handler Vercel aplica autenticação de painel/cron e interpreta rewrite', async () => {
    const { database, repository } = await createDatabase();
    const previousPanelToken = process.env.PANEL_TOKEN, previousCronSecret = process.env.CRON_SECRET;
    process.env.PANEL_TOKEN = 'panel-test';
    process.env.CRON_SECRET = 'cron-test';
    const previousRepeatInterval = process.env.CRON_REPEAT_INTERVAL_MS;
    process.env.CRON_REPEAT_INTERVAL_MS = '0';
    const gateway = new DemoAutocabClient();
    const connections = [{ id: 'main', name: 'Main', gateway }];
    const configuration: AppConfig = { mode: 'dry', baseUrl: 'https://autocab-api.azure-api.net', databasePath: ':memory:', host: '127.0.0.1', port: 3001, panelToken: 'panel-test', intervalMs: 60000, autoStart: false, ...rules, companiesPath: '/booking/v1/companies', autocabTimeoutMs: 10000, driverMessagesMode: 'off', driverMessageRecipients: null, driverMessagesTop: null, driverMessagePath: '/vehicle/v1/vehicles/message', driverMessageFields: { urgent: true }, connections: [] };
    const runner = new NeonCycleRunner(repository, new CorrectionService(repository, rules, 'dry'), connections);
    let runtimeLoads = 0;
    // Em teste a resposta espera o trabalho em segundo plano, para conferir o resultado em seguida.
    const handler = createServerlessHandler(async () => { runtimeLoads++; return { configuration, repository, connections, runner, close: async () => { } }; }, work => work);
    const server = createServer((request, response) => void handler(request, response));
    server.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    try {
        assert.equal((await fetch(base + '/api/handler?route=dashboard')).status, 401);
        assert.equal(runtimeLoads, 0);
        assert.equal((await fetch(base + '/api/cron', { headers: { Authorization: 'Bearer panel-test' } })).status, 401);
        assert.equal((await fetch(base + '/api/handler?route=cron', { headers: { Authorization: 'Bearer cron-test' } })).status, 202);
        const response = await fetch(base + '/api/handler?route=dashboard&connectionId=main', { headers: { Authorization: 'Bearer panel-test' } });
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.zones.length, 4);
        assert.equal(payload.changes.length, 2);
        assert.equal((await fetch(base + '/api/cycles', { method: 'POST', headers: { Authorization: 'Bearer panel-test', Origin: 'https://wrong.example' } })).status, 403);
        // Execução anterior ainda com o lease: o cron responde 202 e o disparo é só pulado, sem novo ciclo.
        await repository.acquireCycleLease('outra-execucao');
        const cyclesBefore = (await repository.getDashboard()).cycles.length;
        assert.equal((await fetch(base + '/api/handler?route=cron', { headers: { Authorization: 'Bearer cron-test' } })).status, 202);
        assert.equal((await repository.getDashboard()).cycles.length, cyclesBefore);
        assert.equal((await fetch(base + '/api/cycles', { method: 'POST', headers: { Authorization: 'Bearer panel-test' } })).status, 409);
        await repository.releaseCycleLease('outra-execucao');
        delete process.env.CRON_SECRET;
        assert.equal((await fetch(base + '/api/cron')).status, 503);
    }
    finally {
        if (previousPanelToken === undefined)
            delete process.env.PANEL_TOKEN;
        else
            process.env.PANEL_TOKEN = previousPanelToken;
        if (previousCronSecret === undefined)
            delete process.env.CRON_SECRET;
        else
            process.env.CRON_SECRET = previousCronSecret;
        if (previousRepeatInterval === undefined)
            delete process.env.CRON_REPEAT_INTERVAL_MS;
        else
            process.env.CRON_REPEAT_INTERVAL_MS = previousRepeatInterval;
        await new Promise<void>(resolve => server.close(() => resolve()));
        await database.close();
    }
});
test('PostgreSQL guarda a fila avisada e as mensagens aos motoristas', async () => {
    const { database, repository } = await createDatabase();
    try {
        await repository.saveZoneQueueSignature('arcoverde', 11, '301,302');
        await repository.saveZoneQueueSignature('arcoverde', 11, '302,301');
        assert.deepEqual([...(await repository.getZoneQueueSignatures('arcoverde'))], [[11, '302,301']]);
        await repository.recordDriverMessage({ connectionId: 'arcoverde', cycleId: 'c1', vehicleId: 301, callsign: 'A1', zoneId: 11, zoneName: 'Praia', queuePosition: 2, message: 'fila', mode: 'dry', outcome: 'simulated', httpStatus: null });
        const messages = (await repository.getDashboard('arcoverde')).messages ?? [];
        assert.equal(messages.length, 1);
        assert.equal(messages[0].vehicleId, 301);
    } finally { await database.close(); }
});
test('retenção apaga histórico antigo e mantém pendências em live', async () => {
    const { database, repository } = await createDatabase();
    try {
        const old = '2020-01-01T00:00:00.000Z';
        await database.query(`INSERT INTO correction_cycles(id,"connectionId",mode,"startedAt",outcome) VALUES('c-old','a','dry','${old}','completed'),('c-new','a','dry','${new Date().toISOString()}','completed')`);
        await repository.recordDriverMessage({ connectionId: 'a', cycleId: 'c', vehicleId: 1, callsign: '1', zoneId: 1, zoneName: 'Z', queuePosition: 1, message: 'm', mode: 'dry', outcome: 'simulated', httpStatus: null });
        await database.query(`UPDATE driver_messages SET "createdAt"='${old}'`);
        await database.query(`INSERT INTO plot_changes(id,"connectionId","cycleId","vehicleId",mode,outcome,"createdAt","changeData") VALUES('p-old','a','c',1,'dry','planned','${old}','{}'),('p-pending','a','c',2,'live','unknown','${old}','{}')`);
        await repository.pruneHistory();
        assert.deepEqual((await database.query('SELECT id FROM correction_cycles')).rows.map(row => (row as { id: string }).id), ['c-new']);
        assert.equal((await database.query('SELECT id FROM driver_messages')).rows.length, 0);
        assert.deepEqual((await database.query('SELECT id FROM plot_changes')).rows.map(row => (row as { id: string }).id), ['p-pending']);
    } finally { await database.close(); }
});
test('falhas de conexão com o banco viram orientação sem expor a mensagem', async () => {
    const { describeDatabaseError } = await import('../server/neon-runtime.ts');
    assert.match(describeDatabaseError({ code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'secret' }), /DATABASE_SSL_CA/);
    assert.match(describeDatabaseError({ code: 'ENETUNREACH' }), /pooler/);
    assert.match(describeDatabaseError({ code: '28P01' }), /senha/);
    assert.doesNotMatch(describeDatabaseError({ code: 'X', message: 'postgres://user:pass@host' }), /pass/);
});
test('TLS do banco aceita a raiz do Supabase só em hosts do Supabase, sem desligar a verificação', async () => {
    const { X509Certificate } = await import('node:crypto');
    const tls = await import('node:tls');
    const { databaseCertificateAuthorities } = await import('../server/neon-runtime.ts');
    const { supabaseRootCertificate } = await import('../server/supabase-ca.ts');
    const certificate = new X509Certificate(supabaseRootCertificate);
    assert.match(certificate.subject, /CN=Supabase Root 2021 CA/);
    assert.equal(certificate.fingerprint256, '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA');
    assert.ok(new Date(certificate.validTo) > new Date());
    const supabase = databaseCertificateAuthorities('aws-0-sa-east-1.pooler.supabase.com');
    assert.ok(supabase.includes(supabaseRootCertificate));
    assert.ok(tls.rootCertificates.every(root => supabase.includes(root)), 'CAs públicas continuam aceitas');
    assert.ok(!databaseCertificateAuthorities('ep-x.sa-east-1.aws.neon.tech').includes(supabaseRootCertificate));
    assert.ok(!databaseCertificateAuthorities('supabase.com.attacker.example').includes(supabaseRootCertificate));
});
test('DATABASE_URL colada com colchetes, aspas ou senha com caracteres especiais é aceita', async () => {
    const { parseDatabaseUrl } = await import('../server/neon-runtime.ts');
    const host = 'aws-0-sa-east-1.pooler.supabase.com:5432';
    const brackets = parseDatabaseUrl(`postgresql://postgres.abc123:[S3nha]@${host}/postgres`);
    assert.equal(brackets.password, 'S3nha');
    assert.equal(brackets.username, 'postgres.abc123');
    assert.equal(brackets.hostname, 'aws-0-sa-east-1.pooler.supabase.com');
    const special = parseDatabaseUrl(`  "postgresql://postgres.abc123:p@ss#w/rd?1@${host}/postgres"  `);
    assert.equal(decodeURIComponent(special.password), 'p@ss#w/rd?1');
    assert.equal(special.pathname, '/postgres');
    const prefixed = parseDatabaseUrl(`DATABASE_URL=postgresql://postgres.abc123:S3nha@${host}/postgres?sslmode=require`);
    assert.equal(prefixed.searchParams.get('sslmode'), 'require');
    assert.equal(decodeURIComponent(parseDatabaseUrl(`postgresql://u:a%40b@${host}/postgres`).password), 'a@b');
    assert.throws(() => parseDatabaseUrl(`postgresql://postgres.abc123:[YOUR-PASSWORD]@${host}/postgres`), /YOUR-PASSWORD/);
    assert.throws(() => parseDatabaseUrl('https://exemplo.com'), error => error instanceof Error && /formato/.test(error.message) && !error.message.includes('exemplo'));
});
// Fila da Arcoverde (zona 11) com GPS lento e uma segunda empresa para conferir a ordem e a velocidade.
function createArcoverdeFleet() {
    const gateway = new DemoAutocabClient();
    let order = [301, 302, 303];
    const events: string[] = [];
    gateway.listZones = async () => [{ id: 11, name: 'Praia', companyId: 1 }, { id: 21, name: 'Centro', companyId: 2 }];
    gateway.listVehicles = async () => [...[301, 302, 303].map(id => ({ id, callsign: 'A' + id, companyId: 1 })), { id: 401, callsign: 'S401', companyId: 2 }];
    gateway.listVehicleStatuses = async () => [...order.map((vehicleId, index) => ({ vehicleId, zoneId: 11, queuePosition: index + 1, status: 'Available', hasPenalty: false })), { vehicleId: 401, zoneId: 21, queuePosition: 1, status: 'Available', hasPenalty: false }];
    gateway.listGpsPositions = async () => [301, 302, 303, 401].map(vehicleId => ({ vehicleId, latitude: -22.9, longitude: -43.2 }));
    gateway.findZoneByCoordinates = async (_latitude: number, _longitude: number, companyId?: number) => { events.push('gps:' + companyId); return null; };
    const sendDriverMessage = gateway.sendDriverMessage.bind(gateway);
    gateway.sendDriverMessage = async (vehicleId: number, message: string) => { events.push('aviso:' + vehicleId); return sendDriverMessage(vehicleId, message); };
    return { gateway, events, setOrder: (next: number[]) => { order = next; } };
}
test('aviso da Arcoverde sai antes da correção por GPS e a Arcoverde roda antes das outras empresas', async () => {
    const { database, repository } = await createDatabase();
    try {
        const { gateway, events, setOrder } = createArcoverdeFleet();
        const service = new CorrectionService(repository, rules, 'dry', 'live');
        const connections = [{ id: 'sao-conrado', name: 'São Conrado', companyId: 2, gateway }, { id: 'arcoverde', name: 'Arcoverde', companyId: 1, driverMessages: true, gateway }];
        const runner = new NeonCycleRunner(repository, service, connections);
        await runner.runOnce();
        assert.ok(events.indexOf('gps:1') >= 0 && events.indexOf('gps:2') > events.indexOf('gps:1'), 'Arcoverde corrige antes da São Conrado');
        setOrder([302, 301, 303]);
        events.length = 0;
        await runner.runOnce();
        assert.deepEqual(events.slice(0, 2).sort(), ['aviso:301', 'aviso:302']);
    } finally { await database.close(); }
});
test('passada rápida da Arcoverde reposiciona e avisa reaproveitando zonas, veículos e GPS de carro parado', async () => {
    const { database, repository } = await createDatabase();
    try {
        const { gateway, events, setOrder } = createArcoverdeFleet();
        const reads: string[] = [];
        for (const name of ['listZones', 'listVehicles', 'listVehicleStatuses', 'listGpsPositions'] as const) {
            const original = gateway[name].bind(gateway) as () => Promise<unknown>;
            (gateway as unknown as Record<string, () => Promise<unknown>>)[name] = async () => { reads.push(name); return original(); };
        }
        const service = new CorrectionService(repository, rules, 'dry', 'live');
        const runner = new NeonCycleRunner(repository, service, [{ id: 'arcoverde', name: 'Arcoverde', companyId: 1, driverMessages: true, gateway }]);
        await runner.runOnce();
        const cycles = (await repository.getDashboard()).cycles.length;
        // Nada mudou: não consulta zonas/veículos nem GPS de carro parado e não registra ciclo.
        reads.length = 0; events.length = 0;
        await runner.runPriorityPass();
        assert.deepEqual(reads.sort(), ['listGpsPositions', 'listVehicleStatuses']);
        assert.ok(!events.some(event => event.startsWith('gps')), 'carro parado não consulta zona de novo');
        assert.equal((await repository.getDashboard()).cycles.length, cycles, 'passada sem mudança não registra ciclo');
        // A fila muda: a passada rápida avisa e registra o ciclo.
        setOrder([303, 301, 302]);
        await runner.runPriorityPass();
        assert.deepEqual(gateway.sentMessages.map(message => message.vehicleId).sort(), [301, 302, 303]);
        const latest = (await repository.getDashboard()).cycles;
        assert.equal(latest.length, cycles + 1);
        assert.match(latest[0].detail ?? '', /passada rápida/);
        // Outra execução com o lease: a passada rápida é pulada.
        await repository.acquireCycleLease('outra');
        setOrder([301, 302, 303]);
        await runner.runPriorityPass();
        assert.equal(gateway.sentMessages.length, 3);
    } finally { await database.close(); }
});
test('passada rápida corrige a zona do carro que se moveu', async () => {
    const { database, repository } = await createDatabase();
    try {
        const gateway = new DemoAutocabClient();
        let latitude = -22.9;
        gateway.listZones = async () => [{ id: 11, name: 'Praia', companyId: 1 }, { id: 12, name: 'Centro', companyId: 1 }];
        gateway.listVehicles = async () => [{ id: 301, callsign: 'A1', companyId: 1 }];
        gateway.listVehicleStatuses = async () => [{ vehicleId: 301, zoneId: 11, queuePosition: 1, status: 'Available', hasPenalty: false }];
        gateway.listGpsPositions = async () => [{ vehicleId: 301, latitude, longitude: -43.2 }];
        let lookups = 0;
        gateway.findZoneByCoordinates = async (lat: number) => { lookups++; return lat < -22.95 ? 12 : 11; };
        const service = new CorrectionService(repository, rules, 'dry', 'dry');
        const runner = new NeonCycleRunner(repository, service, [{ id: 'arcoverde', name: 'Arcoverde', companyId: 1, driverMessages: true, gateway }]);
        await runner.runOnce();
        assert.equal(lookups, 1);
        latitude = -23.0;
        await runner.runPriorityPass();
        assert.equal(lookups, 2, 'carro que se moveu consulta a zona de novo');
        const changes = (await repository.getDashboard()).changes;
        assert.deepEqual(changes.map(change => [change.vehicleId, change.targetZoneName]), [[301, 'Centro']]);
    } finally { await database.close(); }
});
test('cron confere as filas a cada poucos segundos entre as passadas completas', async () => {
    const { runCronPasses } = await import('../server/serverless-handler.ts');
    const previous = { repeat: process.env.CRON_REPEAT_INTERVAL_MS, poll: process.env.DRIVER_MESSAGES_POLL_MS };
    process.env.CRON_REPEAT_INTERVAL_MS = '400';
    process.env.DRIVER_MESSAGES_POLL_MS = '100';
    const calls: string[] = [];
    const runner = { lastRunCompleted: true, async runOnce() { calls.push('passada'); }, async runPriorityPass() { calls.push('fila'); } };
    try {
        const startedAt = Date.now();
        await runCronPasses({ runner, connections: [{ id: 'arcoverde', name: 'Arcoverde', driverMessages: true, gateway: null }] } as never, 1000);
        assert.ok(Date.now() - startedAt <= 1100, 'termina dentro da janela');
        assert.ok(calls.filter(call => call === 'passada').length >= 2);
        assert.ok(calls.filter(call => call === 'fila').length >= 5, `conferências rápidas: ${calls.join(',')}`);
        calls.length = 0;
        await runCronPasses({ runner, connections: [{ id: 'sao-conrado', name: 'São Conrado', gateway: null }] } as never, 1000);
        assert.ok(!calls.includes('fila'), 'sem empresa com aviso não confere filas');
    } finally {
        for (const [name, value] of [['CRON_REPEAT_INTERVAL_MS', previous.repeat], ['DRIVER_MESSAGES_POLL_MS', previous.poll]] as const) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});
