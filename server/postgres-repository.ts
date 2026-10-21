import { randomUUID } from 'node:crypto';
import { CYCLE_LEASE_SECONDS } from './execution-limits.ts';
import type { AuditStore, NewDriverMessage } from './audit-store.ts';
import type { OperatingMode, PlannedChange, ChangeOutcome, ChangeLog, CycleLog, Zone, SavedZone, DashboardData, DriverMessageLog } from '../shared/types.ts';
import { postgresSchema } from './postgres-schema.ts';
export interface SqlExecutor {
    query(sql: string, parameters?: unknown[]): Promise<{
        rows: Record<string, unknown>[];
    }>;
}
export class PostgresAuditRepository implements AuditStore {
    private database: SqlExecutor;
    constructor(database: SqlExecutor) { this.database = database; }
    async initialize() { await this.database.query(postgresSchema); }
    async recoverInterruptedCycles() {
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
    async recordDriverMessage(message: NewDriverMessage) {
        await this.database.query('INSERT INTO driver_messages(id,"connectionId","cycleId","vehicleId",callsign,"zoneId","zoneName","queuePosition",message,mode,outcome,"httpStatus","createdAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [randomUUID(), message.connectionId, message.cycleId, message.vehicleId, message.callsign, message.zoneId, message.zoneName, message.queuePosition, message.message, message.mode, message.outcome, message.httpStatus, new Date().toISOString()]);
    }
}
