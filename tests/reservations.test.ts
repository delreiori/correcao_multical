import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { AutocabClient, AutocabRequestError } from '../server/autocab.ts';
import type { Reservation } from '../server/autocab.ts';
import { PostgresAuditRepository } from '../server/postgres-repository.ts';
import { postgresSchema } from '../server/postgres-schema.ts';
import { DemoAutocabClient } from '../server/demo.ts';
import { notifyReservations, RESERVATION_MESSAGE } from '../server/reservation-messages.ts';
import { CorrectionService } from '../server/correction-service.ts';

test('erro HTTP identifica o endpoint sem expor chave nem query de GPS', async () => {
    const client = new AutocabClient('https://example.com', 'private-key-for-test', (async () =>
        new Response(null, { status: 404 })) as typeof fetch);
    await assert.rejects(client.findZoneByCoordinates(-23.123456, -46.654321, 33), error => {
        assert.ok(error instanceof AutocabRequestError);
        assert.equal(error.httpStatus, 404);
        assert.match(error.message, /HTTP 404 \(GET \/booking\/v1\/zone\)/);
        assert.ok(!error.message.includes('private-key-for-test'));
        assert.ok(!error.message.includes('latitude'));
        assert.ok(!error.message.includes('-23.123456'));
        return true;
    });
});

test('Booking Search v2 usa empresa, paginação e mensagem urgente restrita ao veículo', async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const client = new AutocabClient('https://example.com', 'test', (async (url, init) => {
        const body = JSON.parse(String(init?.body)); requests.push({ url: String(url), body });
        if (String(url).endsWith('/message')) return new Response(null, { status: 204 });
        return Response.json({ bookings: [{ id: requests.length, companyId: 2,
            bookedAtTime: '2026-10-22T10:00:00Z', pickupDueTimeUtc: '2026-10-22T10:30:00Z' }],
            ...(body.continuationToken ? {} : { continuationToken: 'next' }) });
    }) as typeof fetch, 1000, { driverMessageFields: { urgent: false, vehicles: [999], companies: [999] } });
    assert.equal((await client.searchReservations(2)).length, 2);
    assert.equal(requests[0].url, 'https://example.com/booking/v1/1.2/search');
    assert.deepEqual(requests[0].body.companyIds, [2]);
    assert.ok((requests[0].body.types as string[]).includes('Advanced'));
    assert.equal(requests[1].body.continuationToken, 'next');
    await client.sendDriverMessage(42, RESERVATION_MESSAGE, true);
    assert.deepEqual(requests[2].body.vehicles, [42]); assert.equal(requests[2].body.urgent, true);
    assert.deepEqual(requests[2].body.companies, []);
    assert.equal(requests[2].body.text, RESERVATION_MESSAGE);
});

test('reservas São Conrado persistem ativação, deduplicação e resultados no PostgreSQL', async t => {
    const db = new PGlite();
    const sql = { query: async (query: string, parameters?: unknown[]) => {
        if (query === postgresSchema) { await db.exec(query); return { rows: [] }; }
        return db.query<Record<string, unknown>>(query, parameters);
    } };
    const repository = new PostgresAuditRepository(sql);
    await repository.initialize();
    const start = '2026-10-22T10:00:00Z', created = '2026-10-22T10:01:00Z';
    let bookings: Reservation[] = [];
    const sent: unknown[][] = [];
    const gateway = Object.assign(new DemoAutocabClient(), {
        searchReservations: async () => bookings,
        sendDriverMessage: async (...args: [number, string, boolean?]) => { sent.push(args); return 204; }
    });
    const vehicles = [{ id: 42, companyId: 2, callsign: '6001' }, { id: 6001, companyId: 2, callsign: '6002' }, { id: 90, companyId: 1, callsign: '6001' }];
    const base = { store: repository, gateway, connectionId: 'sao-conrado', companyId: 2, cycleId: 'cycle', vehicles,
        mode: 'dry' as const, messagesMode: 'live' as const, now: new Date('2026-10-22T10:02:00Z') };
    const booking = (id: number, due: string, bookedAtTime = created, companyId = 2): Reservation => ({ id, companyId, bookedAtTime, pickupDueTimeUtc: due });
    try {
        await t.test('primeira execução não avisa reservas anteriores', async () => {
            bookings = [booking(1, '2026-10-22T15:00:00Z', '2026-10-22T09:59:00Z')];
            await notifyReservations({ ...base, now: new Date(start) });
            assert.equal(sent.length, 0);
        });
        await t.test('inclui 30 minutos exatos e meses de antecedência; exclui outras empresas e menos de 30', async () => {
            bookings = [booking(2, '2026-10-22T10:31:00Z'), booking(3, '2027-03-01T10:00:00Z'),
                booking(4, '2026-10-22T10:30:59Z'), booking(5, '2026-10-22T15:00:00Z', created, 1)];
            const result = await notifyReservations(base);
            assert.equal(result.sent, 2);
            assert.equal(result.simulated, 0);
            assert.equal(result.failed, 0);
            assert.match(result.detail!, /4 consultadas, 2 elegíveis/);
            assert.match(result.detail!, /1 com menos de 30 min/);
            assert.deepEqual(sent, [[42, RESERVATION_MESSAGE, true], [42, RESERVATION_MESSAGE, true]]);
            assert.ok((await repository.listDriverMessages()).every(m => m.outcome === 'sent' && m.callsign === '6001'));
        });
        await t.test('novo processo e chamadas concorrentes não repetem reservas', async () => {
            const restored = new PostgresAuditRepository(sql);
            await notifyReservations({ ...base, store: restored });
            assert.equal(sent.length, 2);
            bookings = [booking(20, '2026-10-22T15:00:00Z')];
            await Promise.all([notifyReservations({ ...base, store: restored }), notifyReservations(base)]);
            assert.equal(sent.length, 3);
        });
        await t.test('timeout registra incerto e não repete', async () => {
            bookings = [booking(6, '2026-10-22T15:00:00Z')];
            let attempts = 0;
            const failing = Object.assign(Object.create(gateway), { sendDriverMessage: async () => { attempts++; throw new AutocabRequestError('timeout'); } });
            assert.equal((await notifyReservations({ ...base, gateway: failing })).failed, 1);
            await notifyReservations({ ...base, gateway: failing }); assert.equal(attempts, 1);
            assert.equal((await repository.listDriverMessages()).find(m => m.zoneName === 'Agendamento #6')?.outcome, 'unknown');
        });
        await t.test('dry simula sem impedir posterior envio live; demo/off não consultam', async () => {
            const before = sent.length;
            bookings = [booking(7, '2026-10-22T15:00:00Z')];
            assert.equal((await notifyReservations({ ...base, messagesMode: 'dry' })).simulated, 1);
            assert.equal(sent.length, before);
            assert.equal((await notifyReservations(base)).sent, 1);
            const disabled = Object.assign(Object.create(gateway), { searchReservations: async () => { throw new Error('não deveria consultar'); } });
            await notifyReservations({ ...base, gateway: disabled, mode: 'demo' });
            await notifyReservations({ ...base, gateway: disabled, messagesMode: 'off' });
        });
        await t.test('intenção pendente sobrevive a encerramento e recuperação sem novo envio', async () => {
            bookings = [booking(21, '2026-10-22T15:00:00Z')];
            const id = await repository.claimReservationNotice({ connectionId: base.connectionId, companyId: 2,
                bookingId: 21, vehicleId: 42, cycleId: 'interrupted', mode: 'dry', simulated: false });
            assert.ok(id);
            await repository.recoverInterruptedCycles();
            assert.equal((await notifyReservations(base)).sent, 0);
            assert.equal((await repository.listDriverMessages()).find(m => m.id === id)?.outcome, 'unknown');
        });
        await t.test('callsign ausente ou duplicado e horários sem fuso bloqueiam envio', async () => {
            await assert.rejects(notifyReservations({ ...base, vehicles: vehicles.filter(v => v.id !== 42) }), /6001/);
            await assert.rejects(notifyReservations({ ...base, vehicles: [...vehicles, { id: 99, companyId: 2, callsign: '6001' }] }), /ambíguo/);
            bookings = [booking(8, '2026-10-22T15:00:00')];
            await assert.rejects(notifyReservations(base), /fuso/);
        });
        await t.test('o ciclo de correção aciona reservas apenas na São Conrado', async () => {
            bookings = [booking(9, '2026-10-22T15:00:00Z')];
            // Real clock used by the runner; use fresh creation and activation for this check.
            const current = new Date();
            bookings[0].bookedAtTime = current.toISOString();
            bookings[0].pickupDueTimeUtc = new Date(current.getTime() + 3_600_000).toISOString();
            const integrationGateway = Object.assign(Object.create(gateway), { listVehicles: async () => vehicles });
            const service = new CorrectionService(repository, { protectedZoneNames: [], outsideZoneName: '' }, 'dry', 'off', null, null, 'live');
            const before = sent.length;
            await service.runConnection({ id: 'arcoverde', name: 'Arcoverde', companyId: 1, gateway: integrationGateway });
            assert.equal(sent.length, before);
            await service.runConnection({ id: 'sao-conrado', name: 'São Conrado', companyId: 2, gateway: integrationGateway });
            assert.equal(sent.length, before + 1);
        });
        await t.test('histórico filtra reservas antes do limite, separado dos avisos de fila', async () => {
            const { id, createdAt, ...message } = (await repository.listDriverMessages())[0];
            await repository.recordDriverMessage({ ...message, zoneId: 15, zoneName: 'Praia', queuePosition: 1, callsign: '6002' });
            const reservations = await repository.listDriverMessages('sao-conrado', 1, 'reservations');
            assert.equal(reservations.length, 1);
            assert.equal(reservations[0].queuePosition, 0);
            const queue = await repository.listDriverMessages('sao-conrado', 1, 'queue');
            assert.equal(queue.length, 1);
            assert.equal(queue[0].zoneName, 'Praia');
            assert.equal((await repository.listDriverMessages('arcoverde', 1, 'reservations')).length, 0);
        });
        await t.test('falha de GPS não impede captar reserva e o diagnóstico permanece no ciclo', async () => {
            const current = new Date();
            bookings = [booking(22, new Date(current.getTime() + 3_600_000).toISOString(), current.toISOString())];
            const failingGps = Object.assign(Object.create(gateway), {
                listVehicles: async () => vehicles,
                listGpsPositions: async () => { throw new AutocabRequestError('GPS indisponível'); }
            });
            const service = new CorrectionService(repository, { protectedZoneNames: [], outsideZoneName: '' }, 'dry', 'off', null, null, 'live');
            const before = sent.length;
            const outcome = await service.runConnection({ id: 'sao-conrado', name: 'São Conrado', companyId: 2, gateway: failingGps });
            assert.equal(outcome, 'failed');
            assert.equal(sent.length, before + 1);
            const cycle = (await repository.getDashboard('sao-conrado')).cycles.find(c => c.outcome === 'failed' && c.detail?.includes('GPS indisponível'));
            assert.ok(cycle);
            assert.match(cycle.detail!, /1 consultadas, 1 elegíveis/);
            assert.match(cycle.detail!, /1 enviados/);
        });
        await t.test('diagnóstico mostra divergência de horário da reserva sem alterar o fuso silenciosamente', async () => {
            bookings = [{ id: 23, companyId: 2, bookedAtTime: '2026-10-22T16:13:00Z',
                pickupDueTimeUtc: '2026-10-22T14:13:00Z', pickupDueTime: '2026-10-22T17:13:00Z' }];
            const result = await notifyReservations({ ...base, now: new Date('2026-10-22T16:29:00Z') });
            assert.equal(result.sent, 0);
            assert.match(result.detail!, /1 vencidas/);
            assert.match(result.detail!, /reserva #23/);
            assert.match(result.detail!, /pickupDueTimeUtc 2026-10-22T14:13:00.000Z/);
            assert.match(result.detail!, /11:13:00 Brasília/);
            assert.match(result.detail!, /pickupDueTime 2026-10-22T17:13:00.000Z/);
            assert.match(result.detail!, /14:13:00 Brasília/);
        });
    } finally { await db.close(); }
});
