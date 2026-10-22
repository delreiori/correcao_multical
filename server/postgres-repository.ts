import { randomUUID } from 'node:crypto';
import { CYCLE_LEASE_SECONDS } from './execution-limits.ts';
import type { AuditStore, NewDriverMessage, MessageKind } from './audit-store.ts';
import type { OperatingMode, PlannedChange, ChangeOutcome, ChangeLog, CycleLog, Zone, SavedZone, DashboardData, DriverMessageLog } from '../shared/types.ts';
import { postgresSchema } from './postgres-schema.ts';
import { RESERVATION_MESSAGE } from './reservation-messages.ts';
import type { ReservationNotice } from './reservation-messages.ts';
export interface SqlExecutor {
    query(sql: string, parameters?: unknown[]): Promise<{
        rows: Record<string, unknown>[];
    }>;
}
export class PostgresAuditRepository implements AuditStore {
    private database: SqlExecutor;
    constructor(database: SqlExecutor) { this.database = database; }
    async initialize() { await this.database.query(postgresSchema); }
    async reservationMonitorStart(connectionId: string, companyId: number, startedAt: string) {
        const result = await this.database.query(`INSERT INTO reservation_monitors("connectionId","companyId","startedAt") VALUES($1,$2,$3)
            ON CONFLICT ("connectionId","companyId") DO UPDATE SET "startedAt"=reservation_monitors."startedAt" RETURNING "startedAt"`, [connectionId, companyId, startedAt]);
        return String(result.rows[0].startedAt);
    }
    async claimReservationNotice(notice: ReservationNotice) {
        const id = randomUUID();
        // Claim and audit intent in a single statement before the external request.
        const result = await this.database.query(`WITH claimed AS (
            INSERT INTO reservation_notifications("connectionId","companyId","bookingId",callsign,simulated,"messageId")
            VALUES($1,$2,$3,$13,$4,$5) ON CONFLICT DO NOTHING RETURNING "messageId"
        ) INSERT INTO driver_messages(id,"connectionId","cycleId","vehicleId",callsign,"zoneId","zoneName","queuePosition",message,mode,outcome,"createdAt")
            SELECT $5,$1,$6,$7,$13,0,$8,0,$9,$10,$11,$12 FROM claimed RETURNING id`,
            [notice.connectionId, notice.companyId, notice.bookingId, notice.simulated, id, notice.cycleId, notice.vehicleId,
                `Agendamento #${notice.bookingId}`, RESERVATION_MESSAGE, notice.mode, notice.simulated ? 'simulated' : 'pending', new Date().toISOString(), notice.callsign]);
        return result.rows.length ? id : null;
    }
    async finishReservationNotice(id: string, outcome: 'sent' | 'failed' | 'unknown', httpStatus: number | null) {
        await this.database.query('UPDATE driver_messages SET outcome=$1,"httpStatus"=$2 WHERE id=$3', [outcome, httpStatus, id]);
    }
    async recoverInterruptedCycles() {
        await this.database.query("UPDATE driver_messages SET outcome='unknown' WHERE outcome='pending' AND \"zoneId\"=0");
        // Call only after acquiring the global database lease; never at cold start.
        await this.database.query("UPDATE plot_changes SET outcome='unknown',detail='Execução anterior interrompida; consultar antes de repetir' WHERE outcome='pending'");
        await this.database.query("UPDATE correction_cycles SET outcome='interrupted',\"finishedAt\"=$1 WHERE outcome='running'", [new Date().toISOString()]);
    }
    async startCycle(connectionId: string, mode: OperatingMode) {
        const cycleId = randomUUID();
        await this.database.query('INSERT INTO correction_cycles(id,"connectionId",mode,"startedAt",outcome) VALUES($1,$2,$3,$4,$5)', [cycleId, connectionId, mode, new Date().toISOString(), 'running']);
        return cycleId;
    }
    async finishCycle(cycleId: string, outcome: string, inspected: number, planned: number, detail: string | null = null) {
        await this.database.query('UPDATE correction_cycles SET outcome=$1,inspected=$2,planned=$3,detail=$4,"finishedAt"=$5 WHERE id=$6', [outcome, inspected, planned, detail, new Date().toISOString(), cycleId]);
    }
    async createChange(connectionId: string, cycleId: string, mode: OperatingMode, change: PlannedChange, outcome: ChangeOutcome) {
        const changeId = randomUUID();
        await this.database.query('INSERT INTO plot_changes(id,"connectionId","cycleId","vehicleId",mode,outcome,"createdAt","changeData") VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [changeId, connectionId, cycleId, change.vehicleId, mode, outcome, new Date().toISOString(), JSON.stringify(change)]);
        return changeId;
    }
    async finishChange(changeId: string, outcome: ChangeOutcome, httpStatus: number | null = null, detail: string | null = null) {
        await this.database.query('UPDATE plot_changes SET outcome=$1,"httpStatus"=$2,detail=$3,"finishedAt"=$4 WHERE id=$5', [outcome, httpStatus, detail, new Date().toISOString(), changeId]);
    }
    private decodeChange(row: Record<string, unknown>): ChangeLog {
        const { changeData, ...metadata } = row;
        return { ...changeData as PlannedChange, ...metadata, vehicleId: Number(row.vehicleId) } as ChangeLog;
    }
    async listUnresolvedChanges(connectionId: string) {
        const result = await this.database.query("SELECT * FROM plot_changes WHERE \"connectionId\"=$1 AND mode='live' AND outcome IN ('pending','unknown','unconfirmed')", [connectionId]);
        return result.rows.map(row => this.decodeChange(row));
    }
    async saveZones(connectionId: string, zones: Zone[]) {
        // One statement: readers never see a partially refreshed catalogue.
        await this.database.query(`WITH removed AS (
   DELETE FROM autocab_zones WHERE "connectionId"=$1 AND id NOT IN (SELECT (value->>'id')::bigint FROM jsonb_array_elements($2::jsonb))
  ) INSERT INTO autocab_zones("connectionId",id,name,"companyId","updatedAt")
   SELECT $1,(value->>'id')::bigint,value->>'name',(value->>'companyId')::bigint,$3 FROM jsonb_array_elements($2::jsonb)
   ON CONFLICT ("connectionId",id) DO UPDATE SET name=EXCLUDED.name,"companyId"=EXCLUDED."companyId","updatedAt"=EXCLUDED."updatedAt"`, [connectionId, JSON.stringify(zones), new Date().toISOString()]);
    }
    async getDashboard(connectionId: string | null = null): Promise<DashboardData> {
        const filter = connectionId ? ' WHERE "connectionId"=$1' : '';
        const parameters = connectionId ? [connectionId] : [];
        const [changes, cycles, zones, count, messages] = await Promise.all([
            this.database.query('SELECT * FROM plot_changes' + filter + ' ORDER BY "createdAt" DESC,id DESC LIMIT 500', parameters),
            this.database.query('SELECT * FROM correction_cycles' + filter + ' ORDER BY "startedAt" DESC,id DESC LIMIT 100', parameters),
            this.database.query('SELECT * FROM autocab_zones' + filter + ' ORDER BY "connectionId",name', parameters),
            this.database.query('SELECT COUNT(*) AS total FROM plot_changes' + filter, parameters),
            this.database.query('SELECT * FROM driver_messages' + filter + ' ORDER BY "createdAt" DESC,id DESC LIMIT 200', parameters)
        ]);
        return { changes: changes.rows.map(row => this.decodeChange(row)), cycles: cycles.rows as unknown as CycleLog[], zones: zones.rows.map(row => ({ ...row, id: Number(row.id), companyId: row.companyId === null ? null : Number(row.companyId) })) as unknown as SavedZone[], totalChanges: Number(count.rows[0]?.total ?? 0), messages: messages.rows.map(row => ({ ...row, vehicleId: Number(row.vehicleId), zoneId: Number(row.zoneId) })) as unknown as DriverMessageLog[] };
    }
    async acquireCycleLease(owner: string) {
        const result = await this.database.query(`INSERT INTO correction_lock(name,owner,"expiresAt") VALUES('autocab', $1, now()+($2::integer * interval '1 second'))
   ON CONFLICT(name) DO UPDATE SET owner=EXCLUDED.owner,"expiresAt"=EXCLUDED."expiresAt" WHERE correction_lock."expiresAt"<now() RETURNING owner`, [owner, CYCLE_LEASE_SECONDS]);
        return result.rows.length === 1;
    }
    async releaseCycleLease(owner: string) { await this.database.query('DELETE FROM correction_lock WHERE name=$1 AND owner=$2', ['autocab', owner]); }
    async getVehicleCursor(connectionId: string) { const result = await this.database.query('SELECT "vehicleId" FROM vehicle_cursors WHERE "connectionId"=$1', [connectionId]); return Number(result.rows[0]?.vehicleId ?? -1); }
    async saveVehicleCursor(connectionId: string, vehicleId: number) { await this.database.query('INSERT INTO vehicle_cursors("connectionId","vehicleId") VALUES($1,$2) ON CONFLICT("connectionId") DO UPDATE SET "vehicleId"=EXCLUDED."vehicleId"', [connectionId, vehicleId]); }
    async getZoneQueueSignatures(connectionId: string) {
        const result = await this.database.query('SELECT "zoneId",signature FROM zone_queue_signatures WHERE "connectionId"=$1', [connectionId]);
        return new Map(result.rows.map(row => [Number(row.zoneId), String(row.signature)]));
    }
    async saveZoneQueueSignature(connectionId: string, zoneId: number, signature: string) {
        await this.database.query('INSERT INTO zone_queue_signatures("connectionId","zoneId",signature,"updatedAt") VALUES($1,$2,$3,$4) ON CONFLICT("connectionId","zoneId") DO UPDATE SET signature=EXCLUDED.signature,"updatedAt"=EXCLUDED."updatedAt"', [connectionId, zoneId, signature, new Date().toISOString()]);
    }
    async listDriverMessages(connectionId: string | null = null, limit = 1000, kind?: MessageKind) {
        const conditions = [];
        const parameters: unknown[] = [];
        if (connectionId) { parameters.push(connectionId); conditions.push('"connectionId"=$1'); }
        if (kind) conditions.push(`${kind === 'queue' ? 'NOT ' : ''}("zoneId"=0 AND "queuePosition"=0)`);
        parameters.push(limit);
        const result = await this.database.query('SELECT * FROM driver_messages' + (conditions.length ? ' WHERE ' + conditions.join(' AND ') : '')
            + ` ORDER BY "createdAt" DESC,id DESC LIMIT $${parameters.length}`, parameters);
        return result.rows.map(row => ({ ...row, vehicleId: Number(row.vehicleId), zoneId: Number(row.zoneId) })) as unknown as DriverMessageLog[];
    }
    async recordDriverMessage(message: NewDriverMessage) {
        await this.database.query('INSERT INTO driver_messages(id,"connectionId","cycleId","vehicleId",callsign,"zoneId","zoneName","queuePosition",message,mode,outcome,"httpStatus","createdAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [randomUUID(), message.connectionId, message.cycleId, message.vehicleId, message.callsign, message.zoneId, message.zoneName, message.queuePosition, message.message, message.mode, message.outcome, message.httpStatus, new Date().toISOString()]);
    }
    // Retenção: ciclos por 7 dias, avisos por 30 e alterações por 90 (as pendentes em live ficam).
    async pruneHistory(now = new Date()) {
        const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
        await this.database.query('DELETE FROM correction_cycles WHERE "startedAt"<$1 AND outcome<>\'running\'', [daysAgo(7)]);
        await this.database.query('DELETE FROM driver_messages WHERE "createdAt"<$1', [daysAgo(30)]);
        await this.database.query("DELETE FROM plot_changes WHERE \"createdAt\"<$1 AND NOT (mode='live' AND outcome IN ('pending','unknown','unconfirmed'))", [daysAgo(90)]);
    }
}
