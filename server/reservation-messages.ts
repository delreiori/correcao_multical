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
    callsign: string;
    mode: OperatingMode;
    simulated: boolean;
}
interface ReservationResult { sent: number; simulated: number; failed: number; detail?: string }
function timestamp(value: string): number {
    // Never interpret provider timestamps in the machine's local timezone.
    if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)))
        throw new Error('Horário da reserva inválido ou sem fuso horário');
    return Date.parse(value);
}
function showProviderTime(value: string): string {
    try {
        const time = timestamp(value);
        return `${new Date(time).toISOString()} (${new Date(time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} Brasília)`;
    } catch {
        return 'inválido ou sem fuso';
    }
}
export async function notifyReservations(options: {
    store: AuditStore; gateway: AutocabGateway; connectionId: string; companyId: number;
    cycleId: string; vehicles: Vehicle[]; mode: OperatingMode;
    messagesMode: 'off' | 'dry' | 'live'; now?: Date; deadline?: number;
}): Promise<ReservationResult> {
    if (options.messagesMode === 'off' || options.mode === 'demo') return { sent: 0, simulated: 0, failed: 0 };
    const { store, gateway } = options;
    if (!store.reservationMonitorStart || !store.claimReservationNotice || !store.finishReservationNotice || !gateway.searchReservations)
        throw new Error('Avisos de reserva exigem PostgreSQL e Booking Search v2');
    // Vehicle API addresses terminals by vehicle ID; only this company's fleet is eligible.
    const byId = new Map<number, Vehicle>();
    const byCallsign = new Map<string, number>();
    for (const vehicle of options.vehicles.filter(v => v.companyId === options.companyId)) {
        if ((byCallsign.has(vehicle.callsign) && byCallsign.get(vehicle.callsign) !== vehicle.id)
            || (byId.has(vehicle.id) && byId.get(vehicle.id)!.callsign !== vehicle.callsign))
            throw new Error('Cadastro de veículos ambíguo na São Conrado; nenhum aviso enviado');
        byId.set(vehicle.id, vehicle);
        byCallsign.set(vehicle.callsign, vehicle.id);
    }
    const recipients = [...byId.values()];
    if (!recipients.length) throw new Error('Nenhum veículo encontrado na São Conrado; nenhum aviso enviado');
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + 45_000);
    const searchStartedAt = options.now ?? new Date();
    const startedAt = await store.reservationMonitorStart(options.connectionId, options.companyId, searchStartedAt.toISOString());
    const bookings = await gateway.searchReservations(options.companyId);
    // A booking may be created while the remote search is in progress.
    const now = options.now ?? new Date();
    const counts = { otherCompany: 0, beforeStart: 0, futureCreation: 0, past: 0, tooShort: 0, duplicate: 0 };
    // Validate the complete result before sending anything.
    const eligible = bookings.map(b => ({ b, created: timestamp(b.bookedAtTime), due: timestamp(b.pickupDueTimeUtc) }))
        .filter(({ b, created, due }) => {
            if (b.companyId !== options.companyId) { counts.otherCompany++; return false; }
            if (created < timestamp(startedAt)) { counts.beforeStart++; return false; }
            if (created > now.getTime()) { counts.futureCreation++; return false; }
            if (due <= now.getTime()) { counts.past++; return false; }
            if (due - created < 30 * 60_000) { counts.tooShort++; return false; }
            return true;
        });
    const result: ReservationResult = { sent: 0, simulated: 0, failed: 0 };
    let deferred = false;
    sending: for (const { b } of eligible) {
        // Bound external concurrency and leave unclaimed recipients for the next cron pass.
        for (let offset = 0; offset < recipients.length; offset += 4) {
            if (Date.now() >= deadline) { deferred = true; break sending; }
            const outcomes = await Promise.allSettled(recipients.slice(offset, offset + 4).map(async recipient => {
                const simulated = options.messagesMode !== 'live';
                const id = await store.claimReservationNotice!({ connectionId: options.connectionId, companyId: options.companyId,
                    bookingId: b.id, cycleId: options.cycleId, vehicleId: recipient.id, callsign: recipient.callsign, mode: options.mode, simulated });
                if (!id) { counts.duplicate++; return; }
                if (simulated) { result.simulated++; return; }
                let status: number;
                try {
                    status = await gateway.sendDriverMessage(recipient.id, RESERVATION_MESSAGE, true);
                } catch (error) {
                    const httpStatus = error instanceof AutocabRequestError ? error.httpStatus : null;
                    await store.finishReservationNotice!(id, httpStatus !== null && httpStatus >= 400 && httpStatus < 500 ? 'failed' : 'unknown', httpStatus);
                    result.failed++;
                    return;
                }
                // Pending intent remains durable if persistence fails after delivery.
                await store.finishReservationNotice!(id, 'sent', status);
                result.sent++;
            }));
            if (outcomes.some(outcome => outcome.status === 'rejected'))
                throw new Error('Falha ao registrar avisos de reservas; consulte os envios pendentes no histórico');
        }
    }
    result.detail = `reservas empresa ${options.companyId}: ${bookings.length} consultadas, ${eligible.length} elegíveis, ${counts.beforeStart} anteriores ao monitor (${startedAt}), ${counts.tooShort} com menos de 30 min, ${counts.past} vencidas, ${counts.futureCreation} com criação futura, ${counts.otherCompany} de outra empresa, ${counts.duplicate} destinatários já registrados; ${recipients.length} motoristas da São Conrado${deferred ? '; destinatários restantes serão retomados no próximo ciclo' : ''}`;
    // A small sample of timing fields lets operators investigate timezone discrepancies
    // without exposing passenger names, addresses, phone numbers or the raw API response.
    const sample = [...bookings].filter(b => b.companyId === options.companyId)
        .sort((a, b) => timestamp(b.bookedAtTime) - timestamp(a.bookedAtTime)).slice(0, 5);
    if (sample.length) result.detail += `; consulta em ${showProviderTime(now.toISOString())}; ` + sample.map(b =>
        `reserva #${b.id}${b.bookingType ? ' tipo ' + b.bookingType : ''}${b.timingSource ? ' (horários da ' + (b.timingSource === 'detail' ? 'consulta individual' : 'busca') + ')' : ''}: criação ${showProviderTime(b.bookedAtTime)}, pickupDueTimeUtc ${showProviderTime(b.pickupDueTimeUtc)}`
        + (b.pickupDueTime ? `, pickupDueTime ${showProviderTime(b.pickupDueTime)}` : '')).join('; ');
    return result;
}
