import type { AutocabGateway } from './autocab.ts';
import type { AuditStore } from './audit-store.ts';
import type { DriverMessagesMode } from './config.ts';
import { AutocabRequestError } from './autocab.ts';
import { isBusy, isProtectedZone } from './rules.ts';
import type { ZoneRules } from './rules.ts';
import type { DriverMessageOutcome, OperatingMode, Vehicle, VehicleStatus, Zone } from '../shared/types.ts';
export interface ZoneQueue {
    zone: Zone;
    // Motoristas livres na zona, na ordem da fila (1º, 2º, 3º...).
    drivers: { vehicleId: number; callsign: string }[];
}
// Quantos motoristas da fila aparecem no texto; o restante vira "+N".
const LISTED_DRIVERS = 10;
const MESSAGE_CONCURRENCY = 8;
// Filas das zonas da empresa. Motorista ocupado (já trabalhando) não entra na fila nem recebe o aviso;
// zonas protegidas (NAK, FORA DE AREA) não têm fila a avisar.
export function buildZoneQueues(zones: Zone[], statuses: VehicleStatus[], vehiclesById: Map<number, Vehicle>, rules: ZoneRules): ZoneQueue[] {
    return zones.filter(zone => !isProtectedZone(zone, rules)).map(zone => {
        const drivers = statuses
            .filter(status => status.zoneId === zone.id && !isBusy(status) && vehiclesById.has(status.vehicleId))
            .sort((left, right) => (left.queuePosition ?? Infinity) - (right.queuePosition ?? Infinity) || left.vehicleId - right.vehicleId)
            .map(status => ({ vehicleId: status.vehicleId, callsign: vehiclesById.get(status.vehicleId)!.callsign }));
        return { zone, drivers };
    });
}
export function queueSignature(queue: ZoneQueue) { return queue.drivers.map(driver => driver.vehicleId).join(','); }
export function buildQueueMessage(companyName: string, queue: ZoneQueue, recipientIndex: number) {
    const listed = queue.drivers.slice(0, LISTED_DRIVERS).map((driver, index) => `${index + 1}º ${driver.callsign}`).join(' | ');
    const remaining = queue.drivers.length - LISTED_DRIVERS;
    return `${companyName.toUpperCase()} - Fila ${queue.zone.name} atualizada. Você é o ${recipientIndex + 1}º. ${listed}${remaining > 0 ? ` | +${remaining}` : ''}`;
}
// Avisa os motoristas livres de cada zona cuja fila mudou desde o último aviso. Na primeira leitura
// de uma zona apenas guarda a fila, sem enviar, para não disparar mensagens a toda a frota no deploy.
export async function notifyQueueChanges(options: {
    store: AuditStore;
    gateway: AutocabGateway;
    connectionId: string;
    companyName: string;
    cycleId: string;
    mode: OperatingMode;
    messagesMode: DriverMessagesMode;
    zones: Zone[];
    statuses: VehicleStatus[];
    vehicles: Vehicle[];
    rules: ZoneRules;
}): Promise<{ zonesChanged: number; messages: number; failed: number }> {
    const { store, gateway, connectionId } = options;
    if (options.messagesMode === 'off' || !store.getZoneQueueSignatures || !store.saveZoneQueueSignature || !store.recordDriverMessage)
        return { zonesChanged: 0, messages: 0, failed: 0 };
    // Envio real só com AUTOCAB_MODE=live e DRIVER_MESSAGES_MODE=live; senão apenas registra.
    const sendForReal = options.messagesMode === 'live' && options.mode === 'live';
    const vehiclesById = new Map(options.vehicles.map(vehicle => [vehicle.id, vehicle]));
    const previousSignatures = await store.getZoneQueueSignatures(connectionId);
    let zonesChanged = 0, messages = 0, failed = 0;
    for (const queue of buildZoneQueues(options.zones, options.statuses, vehiclesById, options.rules)) {
        const signature = queueSignature(queue);
        const previous = previousSignatures.get(queue.zone.id);
        if (previous === signature)
            continue;
        await store.saveZoneQueueSignature(connectionId, queue.zone.id, signature);
        if (previous === undefined || queue.drivers.length === 0)
            continue;
        zonesChanged++;
        for (let start = 0; start < queue.drivers.length; start += MESSAGE_CONCURRENCY) {
            await Promise.all(queue.drivers.slice(start, start + MESSAGE_CONCURRENCY).map(async (driver, offset) => {
                const queuePosition = start + offset;
                const message = buildQueueMessage(options.companyName, queue, queuePosition);
                let outcome: DriverMessageOutcome = 'simulated', httpStatus: number | null = null;
                if (sendForReal) {
                    try {
                        httpStatus = await gateway.sendDriverMessage(driver.vehicleId, message);
                        outcome = 'sent';
                    }
                    catch (error) {
                        httpStatus = error instanceof AutocabRequestError ? error.httpStatus : null;
                        outcome = 'failed';
                        failed++;
                    }
                }
                messages++;
                await store.recordDriverMessage!({ connectionId, cycleId: options.cycleId, vehicleId: driver.vehicleId, callsign: driver.callsign, zoneId: queue.zone.id, zoneName: queue.zone.name, queuePosition: queuePosition + 1, message, mode: options.mode, outcome, httpStatus });
            }));
        }
    }
    return { zonesChanged, messages, failed };
}
