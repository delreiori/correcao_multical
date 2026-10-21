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
// O texto lista os primeiros da fila (os que podem receber o aviso); o restante vira "+N".
export function buildQueueMessage(companyName: string, queue: ZoneQueue, recipientIndex: number, listedDrivers = 7) {
    const listed = queue.drivers.slice(0, listedDrivers).map((driver, index) => `${index + 1}º ${driver.callsign}`).join(' | ');
    const remaining = queue.drivers.length - listedDrivers;
    return `${companyName.toUpperCase()} - Fila ${queue.zone.name} atualizada. Você é o ${recipientIndex + 1}º. ${listed}${remaining > 0 ? ` | +${remaining}` : ''}`;
}
// Avisa, entre os primeiros da fila de cada zona (padrão 7), só os motoristas livres cuja posição mudou
// desde a última leitura, incluindo quem acabou de entrar nesse grupo. Na primeira leitura de uma zona
// apenas guarda a fila, sem enviar, para não disparar mensagens a toda a frota no deploy.
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
    // Callsigns ou IDs autorizados a receber; null = todos. A fila listada na mensagem continua completa.
    recipients?: string[] | null;
    // Quantos primeiros da fila podem receber o aviso.
    topDrivers?: number;
}): Promise<{ zonesChanged: number; messages: number; failed: number }> {
    const { store, gateway, connectionId } = options;
    if (options.messagesMode === 'off' || !store.getZoneQueueSignatures || !store.saveZoneQueueSignature || !store.recordDriverMessage)
        return { zonesChanged: 0, messages: 0, failed: 0 };
    // Envio real com DRIVER_MESSAGES_MODE=live, mesmo com as correções em dry, para testar com poucos
    // motoristas; nunca em demo. Fora disso apenas registra.
    const sendForReal = options.messagesMode === 'live' && options.mode !== 'demo';
    const allowed = options.recipients ? new Set(options.recipients) : null;
    const topDrivers = options.topDrivers ?? 7;
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
        const previousPositions = new Map(previous.split(',').filter(Boolean).map((vehicleId, index) => [Number(vehicleId), index]));
        const recipients = queue.drivers.slice(0, topDrivers)
            .map((driver, queuePosition) => ({ driver, queuePosition }))
            .filter(({ driver, queuePosition }) => previousPositions.get(driver.vehicleId) !== queuePosition)
            .filter(({ driver }) => !allowed || allowed.has(driver.callsign) || allowed.has(String(driver.vehicleId)));
        if (recipients.length === 0)
            continue;
        zonesChanged++;
        for (let start = 0; start < recipients.length; start += MESSAGE_CONCURRENCY) {
            await Promise.all(recipients.slice(start, start + MESSAGE_CONCURRENCY).map(async ({ driver, queuePosition }) => {
                const message = buildQueueMessage(options.companyName, queue, queuePosition, topDrivers);
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
