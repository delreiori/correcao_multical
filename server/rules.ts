import type { Zone, VehicleStatus, VehicleGpsPosition, PlannedChange } from '../shared/types.ts';
export interface ZoneRules {
    protectedZoneNames: string[];
    outsideZoneName: string;
}
export function normalizeZoneName(name: string) { return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase(); }
export function isBusy(status: VehicleStatus) { return /busy|ocupad/i.test(status.status); }
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
