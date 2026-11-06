import type { Zone, VehicleStatus, VehicleGpsPosition, PlannedChange } from '../shared/types.ts';
export interface ZoneRules {
    protectedZoneNames: string[];
    outsideZoneName: string;
}
export function normalizeZoneName(name: string) { return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase(); }
// Ocupado: os tipos Busy* da Autocab (BusyMeterOnFromClear é a corrida de rua/street booking) e nomes
// equivalentes de corrida de rua, passageiro a bordo ou despacho. BUSY_STATUSES acrescenta outros
// tipos exatos, separados por vírgula, sem mudar o código.
const BUSY_STATUS_PATTERN = /busy|ocupad|street|pick ?up|picked|meter ?on|dispatch|passenger|on ?job|hired|engaged/i;
let extraBusyStatuses: { source: string | undefined; names: Set<string> } = { source: undefined, names: new Set() };
export function isBusy(status: VehicleStatus) {
    const source = process.env.BUSY_STATUSES;
    if (extraBusyStatuses.source !== source)
        extraBusyStatuses = { source, names: new Set((source ?? '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean)) };
    return BUSY_STATUS_PATTERN.test(status.status) || extraBusyStatuses.names.has(status.status.trim().toLowerCase());
}
// Resumo dos tipos de status da empresa (ex.: "Clear 40, BusyMeterOnFromClear 3 (ocupado)"), para
// conferir no painel como a Autocab informa cada situação.
export function summarizeStatuses(statuses: VehicleStatus[]) {
    const counts = new Map<string, { count: number; busy: boolean }>();
    for (const status of statuses) {
        const entry = counts.get(status.status) ?? { count: 0, busy: isBusy(status) };
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
    if (isBusy(status)) {
        if (!outsideZone || outsideZone.id === currentZone.id || isProtectedZone(currentZone, rules))
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
