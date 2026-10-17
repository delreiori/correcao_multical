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
    const matchingZones = zones.filter(zone => normalizeZoneName(zone.name) === normalizeZoneName(rules.outsideZoneName));
    if (matchingZones.length !== 1)
        throw new Error('Zona FORA DE AREA configurada está ausente ou ambígua nesta conexão/empresa');
    return matchingZones[0];
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
export function calculateQueueTail(statuses: VehicleStatus[], zoneId: number): number {
    const zoneStatuses = statuses.filter(status => status.zoneId === zoneId);
    const highestPosition = zoneStatuses.reduce((highest, status) => Math.max(highest, status.queuePosition ?? 0), 0);
    return Math.max(highestPosition, zoneStatuses.length);
}
export function describeChange(status: VehicleStatus, currentZone: Zone, targetZone: Zone, callsign: string, gpsPosition: VehicleGpsPosition | undefined, position: number): PlannedChange {
    return { vehicleId: status.vehicleId, callsign, previousZoneId: currentZone.id, previousZoneName: currentZone.name, targetZoneId: targetZone.id, targetZoneName: targetZone.name, position, reason: isBusy(status) ? 'busy-outside' : 'gps', latitude: gpsPosition?.latitude ?? null, longitude: gpsPosition?.longitude ?? null };
}
