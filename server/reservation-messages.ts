import type { AuditStore } from './audit-store.ts';
import { AutocabRequestError } from './autocab.ts';
import type { AutocabGateway } from './autocab.ts';
import type { OperatingMode, Vehicle } from '../shared/types.ts';
export const RESERVATION_MESSAGE = 'nova corrida agendada checar tela de agendamentos';
export interface ReservationNotice {
    connectionId: string;
    companyId: number;
    bookingId: number;
    cycleId: string;
    vehicleId: number;
    mode: OperatingMode;
    simulated: boolean;
}
function timestamp(value: string): number {
    // Never interpret provider timestamps in the machine's local timezone.
    if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)))
        throw new Error('Horário da reserva inválido ou sem fuso horário');
    return Date.parse(value);
}
export async function notifyReservations(options: {
    store: AuditStore; gateway: AutocabGateway; connectionId: string; companyId: number;
    cycleId: string; vehicles: Vehicle[]; mode: OperatingMode;
    messagesMode: 'off' | 'dry' | 'live'; now?: Date;
}) {
    if (options.messagesMode === 'off' || options.mode === 'demo') return { sent: 0, simulated: 0, failed: 0 };
    const { store, gateway } = options;
    if (!store.reservationMonitorStart || !store.claimReservationNotice || !store.finishReservationNotice || !gateway.searchReservations)
        throw new Error('Avisos de reserva exigem PostgreSQL e Booking Search v2');
    // Only an exact callsign within this company is authorized. Never interpret 6001 as a vehicle ID.
    const recipients = options.vehicles.filter(v => v.companyId === options.companyId && v.callsign === '6001');
    if (recipients.length !== 1) throw new Error('Callsign 6001 ausente ou ambíguo na São Conrado; nenhum aviso enviado');
    const now = options.now ?? new Date();
    const startedAt = await store.reservationMonitorStart(options.connectionId, options.companyId, now.toISOString());
    const bookings = await gateway.searchReservations(options.companyId);
    // Validate the complete result before sending anything.
    const eligible = bookings.map(b => ({ b, created: timestamp(b.bookedAtTime), due: timestamp(b.pickupDueTimeUtc) }))
        .filter(({ b, created, due }) => b.companyId === options.companyId && created >= timestamp(startedAt)
            && created <= now.getTime() && due > now.getTime() && due - created >= 30 * 60_000);
    const result = { sent: 0, simulated: 0, failed: 0 };
    for (const { b } of eligible) {
        const simulated = options.messagesMode !== 'live';
        const id = await store.claimReservationNotice({ connectionId: options.connectionId, companyId: options.companyId,
            bookingId: b.id, cycleId: options.cycleId, vehicleId: recipients[0].id, mode: options.mode, simulated });
        if (!id) continue;
        if (simulated) { result.simulated++; continue; }
        let status: number;
        try {
            status = await gateway.sendDriverMessage(recipients[0].id, RESERVATION_MESSAGE, true);
        } catch (error) {
            const httpStatus = error instanceof AutocabRequestError ? error.httpStatus : null;
            // Never retry automatically after a possibly delivered request (timeout/server error).
            await store.finishReservationNotice(id, httpStatus !== null && httpStatus >= 400 && httpStatus < 500 ? 'failed' : 'unknown', httpStatus);
            result.failed++;
            continue;
        }
        // If audit persistence fails after delivery, keep the pending claim; do not send again.
        await store.finishReservationNotice(id, 'sent', status);
        result.sent++;
    }
    return result;
}
