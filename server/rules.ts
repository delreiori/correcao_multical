import type { Zone, VehicleStatus, VehicleGpsPosition, PlannedChange } from '../shared/types.ts';
export interface ZoneRules {
    protectedZoneNames: string[];
    outsideZoneName: string;
    // Arcoverde: todo carro não livre vai para fora de área (inclusive fora de serviço/pausa), menos
    // status NAK/sem GPS. Nas outras empresas, fora de serviço/pausa não conta como ocupado.
    allNotFreeToOutside?: boolean;
}
export function normalizeZoneName(name: string) { return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase(); }
// Livre é só o status de livre da Autocab (Clear e equivalentes); fora de serviço/pausa não é ocupado.
// Qualquer outro status de quem está trabalhando conta como ocupado (Busy*, corrida de rua, oferta de
// corrida, quase livre etc.), e também atPickup/dispatchInProgress mesmo com status Clear.
// FREE_STATUSES e BUSY_STATUSES ajustam tipos exatos, separados por vírgula, sem mudar o código.
const FREE_STATUS_PATTERN = /^(clear|available|free|livre|disponivel)$/;
const OFF_DUTY_PATTERN = /not ?working|offline|off ?duty|logged ?(off|out)|break|pausa|suspen|away|fora de servico/;
const statusLists = new Map<string, { source: string | undefined; names: Set<string> }>();
function statusList(variable: 'FREE_STATUSES' | 'BUSY_STATUSES') {
    const source = process.env[variable];
    let list = statusLists.get(variable);
    if (!list || list.source !== source) {
        list = { source, names: new Set((source ?? '').split(',').map(name => normalizeStatusName(name)).filter(Boolean)) };
        statusLists.set(variable, list);
    }
    return list.names;
}
function normalizeStatusName(name: string) { return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(); }
export function isOffDuty(status: VehicleStatus) {
    const name = normalizeStatusName(status.status);
    return OFF_DUTY_PATTERN.test(name) && !statusList('BUSY_STATUSES').has(name);
}
// Não livre: qualquer status que não seja livre (Clear e equivalentes), inclusive fora de serviço/pausa.
export function isNotFree(status: VehicleStatus) {
    if (status.atPickup || status.dispatchInProgress)
        return true;
    const name = normalizeStatusName(status.status);
    if (statusList('BUSY_STATUSES').has(name))
        return true;
    return !(statusList('FREE_STATUSES').has(name) || FREE_STATUS_PATTERN.test(name));
}
// Ocupado (regra padrão): não livre e trabalhando; fora de serviço/pausa não conta.
export function isBusy(status: VehicleStatus) { return isNotFree(status) && !isOffDuty(status); }
// Ocupado conforme a regra da empresa (Arcoverde usa isNotFree).
export function isBusyFor(status: VehicleStatus, rules: ZoneRules) { return rules.allNotFreeToOutside ? isNotFree(status) : isBusy(status); }
// Status NAK ou sem sinal de GPS não vão para fora de área (as zonas NAK e S/GPS são protegidas).
export function isExemptFromOutside(status: VehicleStatus) { return /(^|[^a-z])nak([^a-z]|$)|gps/.test(normalizeStatusName(status.status)); }
// Livre de verdade, na fila esperando corrida: nem ocupado nem fora de serviço.
export function isAvailable(status: VehicleStatus) { return !isBusy(status) && !isOffDuty(status); }
// Resumo dos tipos de status da empresa (ex.: "Clear 40, BusyMeterOnFromClear 3 (ocupado)"), para
// conferir no painel como a Autocab informa cada situação.
export function summarizeStatuses(statuses: VehicleStatus[], rules?: ZoneRules) {
    const counts = new Map<string, { count: number; busy: boolean }>();
    for (const status of statuses) {
        const entry = counts.get(status.status) ?? { count: 0, busy: rules ? isBusyFor(status, rules) : isBusy(status) };
        entry.count++;
        counts.set(status.status, entry);
    }
    return [...counts].sort((left, right) => right[1].count - left[1].count).map(([name, entry]) => `${name} ${entry.count}${entry.busy ? ' (ocupado)' : ''}`).join(', ');
}
export function isProtectedZone(zone: Zone, rules: ZoneRules) {
    const zoneName = normalizeZoneName(zone.name);
    return rules.protectedZoneNames.some(protectedName => zoneName.includes(normalizeZoneName(protectedName)));
}
export function findOutsideZone(zones: Zone[], rules: ZoneRules): Zone | null {
    if (!rules.outsideZoneName)
        return null;
    // outsideZoneName aceita vários nomes separados por vírgula (ex.: "FORA D AREA,FORA DE AREA").
    const acceptedNames = rules.outsideZoneName.split(',').map(name => normalizeZoneName(name)).filter(Boolean);
    const matchingZones = zones.filter(zone => acceptedNames.includes(normalizeZoneName(zone.name)));
    if (matchingZones.length > 1)
        throw new Error('Zona de fora de área ambígua nesta conexão/empresa: mais de uma zona com os nomes configurados');
    // Empresa sem a zona: a regra dos ocupados fica desativada, mas a correção por GPS continua.
    return matchingZones[0] ?? null;
}
export function chooseTargetZone(status: VehicleStatus, currentZone: Zone, gpsZone: Zone | null, outsideZone: Zone | null, rules: ZoneRules): Zone | null {
    if (status.hasPenalty)
        return null;
    if (isBusyFor(status, rules)) {
        if (!outsideZone || outsideZone.id === currentZone.id || isProtectedZone(currentZone, rules) || (rules.allNotFreeToOutside && isExemptFromOutside(status)))
            return null;
        return outsideZone;
    }
    if (!gpsZone || gpsZone.id === currentZone.id || isProtectedZone(gpsZone, rules))
        return null;
    if (isProtectedZone(currentZone, rules) && currentZone.id !== outsideZone?.id)
        return null;
    return gpsZone;
}
// Arcoverde: ocupado (inclusive corrida de rua) acompanha a zona do GPS e não segura posição à frente
// dos livres. Vai para a zona onde está; na mesma zona, só é replotado se algum livre está atrás dele.
export function chooseBusyFollowZone(status: VehicleStatus, currentZone: Zone, gpsZone: Zone | null, statuses: VehicleStatus[], rules: ZoneRules): Zone | null {
    if (status.hasPenalty || !isBusy(status))
        return null;
    const targetZone = gpsZone ?? currentZone;
    if (isProtectedZone(currentZone, rules) || isProtectedZone(targetZone, rules))
        return null;
    if (targetZone.id !== currentZone.id)
        return targetZone;
    if (status.queuePosition === null)
        return null;
    const holdsPositionAheadOfFree = statuses.some(other => other.zoneId === currentZone.id && other.vehicleId !== status.vehicleId && !isBusy(other) && (other.queuePosition ?? 0) > status.queuePosition!);
    return holdsPositionAheadOfFree ? currentZone : null;
}
export function calculateQueueTail(statuses: VehicleStatus[], zoneId: number): number {
    const zoneStatuses = statuses.filter(status => status.zoneId === zoneId);
    const highestPosition = zoneStatuses.reduce((highest, status) => Math.max(highest, status.queuePosition ?? 0), 0);
    return Math.max(highestPosition, zoneStatuses.length);
}
export function describeChange(status: VehicleStatus, currentZone: Zone, targetZone: Zone, callsign: string, gpsPosition: VehicleGpsPosition | undefined, position: number, reason: PlannedChange['reason'] = isBusy(status) ? 'busy-outside' : 'gps'): PlannedChange {
    return { vehicleId: status.vehicleId, callsign, previousZoneId: currentZone.id, previousZoneName: currentZone.name, targetZoneId: targetZone.id, targetZoneName: targetZone.name, position, reason, latitude: gpsPosition?.latitude ?? null, longitude: gpsPosition?.longitude ?? null };
}
