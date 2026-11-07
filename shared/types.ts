export type OperatingMode = 'demo' | 'dry' | 'live';
export type ChangeOutcome = 'planned' | 'pending' | 'confirmed' | 'unconfirmed' | 'unknown' | 'failed' | 'skipped';
export interface Zone {
    id: number;
    name: string;
    companyId: number | null;
    // Tipo da zona na Autocab: Normal, OutOfRange (fora de área), Nak, NoGps, LongBreak, Rejected, Start.
    zoneType?: string | null;
    // Contorno da zona (latitude/longitude), usado na tolerância da correção por GPS.
    boundary?: { latitude: number; longitude: number }[];
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
    // Indo buscar o passageiro / despacho em andamento: contam como ocupado mesmo com status Clear.
    atPickup?: boolean;
    dispatchInProgress?: boolean;
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
    // IDs de todas as zonas ativas (de todas as empresas), para reconhecer carro parado em zona desativada.
    activeZoneIds?: Set<number>;
}
export interface PlannedChange {
    vehicleId: number;
    callsign: string;
    previousZoneId: number;
    previousZoneName: string;
    targetZoneId: number;
    targetZoneName: string;
    position: number;
    reason: 'gps' | 'busy-outside' | 'busy-gps' | 'point';
    // Colocação no ponto (PA1) devolvida pela Autocab: volta na mesma posição, sem ir para o fim da fila.
    keepPosition?: boolean;
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
export type DriverMessageOutcome = 'simulated' | 'sent' | 'failed' | 'pending' | 'unknown';
export interface DriverMessageLog {
    id: string;
    connectionId: string;
    cycleId: string;
    vehicleId: number;
    callsign: string;
    zoneId: number;
    zoneName: string;
    queuePosition: number;
    message: string;
    mode: OperatingMode;
    outcome: DriverMessageOutcome;
    httpStatus: number | null;
    createdAt: string;
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
    messages?: DriverMessageLog[];
}
export interface ConnectionStatus {
    id: string;
    name: string;
    configured: boolean;
    companyId?: number;
    companyName?: string;
}
export interface SystemStatus {
    reservationMessagesMode?: 'off' | 'dry' | 'live';
    execution?: "serverless";
    mode: OperatingMode;
    running: boolean;
    autoStart: boolean;
    intervalMs: number;
    connections: ConnectionStatus[];
}
