export type OperatingMode = 'demo' | 'dry' | 'live';
export type ChangeOutcome = 'planned' | 'pending' | 'confirmed' | 'unconfirmed' | 'unknown' | 'failed' | 'skipped';
export interface Zone {
    id: number;
    name: string;
    companyId: number | null;
}
export interface Company {
    id: number;
    name: string | null;
}
export interface Vehicle {
    id: number;
    callsign: string;
    companyId: number | null;
}
export interface VehicleStatus {
    vehicleId: number;
    zoneId: number | null;
    queuePosition: number | null;
    status: string;
    hasPenalty: boolean;
}
export interface VehicleGpsPosition {
    vehicleId: number;
    latitude: number;
    longitude: number;
}
export interface FleetSnapshot {
    zones: Zone[];
    vehicles: Vehicle[];
    statuses: VehicleStatus[];
    gpsPositions: VehicleGpsPosition[];
}
export interface PlannedChange {
    vehicleId: number;
    callsign: string;
    previousZoneId: number;
    previousZoneName: string;
    targetZoneId: number;
    targetZoneName: string;
    position: number;
    reason: 'gps' | 'busy-outside';
    latitude: number | null;
    longitude: number | null;
}
export interface ChangeLog extends PlannedChange {
    id: string;
    cycleId: string;
    connectionId: string;
    mode: OperatingMode;
    outcome: ChangeOutcome;
    createdAt: string;
    finishedAt: string | null;
    httpStatus: number | null;
    detail: string | null;
}
export interface CycleLog {
    id: string;
    connectionId: string;
    mode: OperatingMode;
    startedAt: string;
    finishedAt: string | null;
    outcome: string;
    inspected: number;
    planned: number;
    detail: string | null;
}
export interface SavedZone extends Zone {
    connectionId: string;
    updatedAt: string;
}
export interface DashboardData {
    changes: ChangeLog[];
    cycles: CycleLog[];
    zones: SavedZone[];
    totalChanges: number;
}
export interface ConnectionStatus {
    id: string;
    name: string;
    configured: boolean;
    companyId?: number;
    companyName?: string;
}
export interface SystemStatus {
    execution?: "serverless";
    mode: OperatingMode;
    running: boolean;
    autoStart: boolean;
    intervalMs: number;
    connections: ConnectionStatus[];
}
