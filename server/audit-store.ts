import type { OperatingMode, PlannedChange, ChangeOutcome, ChangeLog, Zone, DashboardData, DriverMessageLog } from '../shared/types.ts';
import type { ReservationNotice } from './reservation-messages.ts';
export type NewDriverMessage = Omit<DriverMessageLog, 'id' | 'createdAt'>;
export type MessageKind = 'queue' | 'reservations';
type Awaitable<Value> = Value | Promise<Value>;
export interface AuditStore {
    reservationMonitorStart?(connectionId: string, companyId: number, startedAt: string): Promise<string>;
    claimReservationNotice?(notice: ReservationNotice): Promise<string | null>;
    finishReservationNotice?(id: string, outcome: 'sent' | 'failed' | 'unknown', httpStatus: number | null): Promise<void>;
    recoverInterruptedCycles(): Awaitable<void>;
    startCycle(connectionId: string, mode: OperatingMode): Awaitable<string>;
    finishCycle(cycleId: string, outcome: string, inspected: number, planned: number, detail?: string | null): Awaitable<void>;
    createChange(connectionId: string, cycleId: string, mode: OperatingMode, change: PlannedChange, outcome: ChangeOutcome): Awaitable<string>;
    finishChange(changeId: string, outcome: ChangeOutcome, httpStatus?: number | null, detail?: string | null): Awaitable<void>;
    listUnresolvedChanges(connectionId: string): Awaitable<ChangeLog[]>;
    saveZones(connectionId: string, zones: Zone[]): Awaitable<void>;
    getDashboard(connectionId?: string | null): Awaitable<DashboardData>;
    getVehicleCursor?(connectionId: string): Promise<number>;
    saveVehicleCursor?(connectionId: string, vehicleId: number): Promise<void>;
    getZoneQueueSignatures?(connectionId: string): Awaitable<Map<number, string>>;
    saveZoneQueueSignature?(connectionId: string, zoneId: number, signature: string): Awaitable<void>;
    recordDriverMessage?(message: NewDriverMessage): Awaitable<void>;
    listDriverMessages?(connectionId?: string | null, limit?: number, kind?: MessageKind): Awaitable<DriverMessageLog[]>;
}
