import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { OperatingMode, PlannedChange, ChangeOutcome, ChangeLog, CycleLog, Zone, SavedZone, DashboardData, DriverMessageLog } from '../shared/types.ts';
import type { NewDriverMessage } from './audit-store.ts';
export class AuditRepository {
    private database: DatabaseSync;
    constructor(databasePath: string) {
        this.database = new DatabaseSync(databasePath);
        this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS plot_changes(id TEXT PRIMARY KEY,connectionId TEXT NOT NULL,cycleId TEXT NOT NULL,vehicleId INTEGER NOT NULL,mode TEXT NOT NULL,outcome TEXT NOT NULL,createdAt TEXT NOT NULL,finishedAt TEXT,httpStatus INTEGER,detail TEXT,changeData TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS plot_changes_connection_time ON plot_changes(connectionId,createdAt);
   CREATE TABLE IF NOT EXISTS correction_cycles(id TEXT PRIMARY KEY,connectionId TEXT NOT NULL,mode TEXT NOT NULL,startedAt TEXT NOT NULL,finishedAt TEXT,outcome TEXT NOT NULL,inspected INTEGER NOT NULL DEFAULT 0,planned INTEGER NOT NULL DEFAULT 0,detail TEXT);
   CREATE TABLE IF NOT EXISTS autocab_zones(connectionId TEXT NOT NULL,id INTEGER NOT NULL,name TEXT NOT NULL,companyId INTEGER,updatedAt TEXT NOT NULL,PRIMARY KEY(connectionId,id));
   CREATE TABLE IF NOT EXISTS zone_queue_signatures(connectionId TEXT NOT NULL,zoneId INTEGER NOT NULL,signature TEXT NOT NULL,updatedAt TEXT NOT NULL,PRIMARY KEY(connectionId,zoneId));
   CREATE TABLE IF NOT EXISTS driver_messages(id TEXT PRIMARY KEY,connectionId TEXT NOT NULL,cycleId TEXT NOT NULL,vehicleId INTEGER NOT NULL,callsign TEXT NOT NULL,zoneId INTEGER NOT NULL,zoneName TEXT NOT NULL,queuePosition INTEGER NOT NULL,message TEXT NOT NULL,mode TEXT NOT NULL,outcome TEXT NOT NULL,httpStatus INTEGER,createdAt TEXT NOT NULL);`);
    }
    close() { this.database.close(); }
    recoverInterruptedCycles() {
        this.database.prepare("UPDATE plot_changes SET outcome='unknown',detail='Processo interrompido; consultar antes de repetir' WHERE outcome='pending'").run();
        this.database.prepare("UPDATE correction_cycles SET outcome='interrupted',finishedAt=? WHERE outcome='running'").run(new Date().toISOString());
    }
    startCycle(connectionId: string, mode: OperatingMode) {
        const cycleId = randomUUID();
        this.database.prepare('INSERT INTO correction_cycles(id,connectionId,mode,startedAt,outcome) VALUES(?,?,?,?,?)').run(cycleId, connectionId, mode, new Date().toISOString(), 'running');
        return cycleId;
    }
    finishCycle(cycleId: string, outcome: string, inspected: number, planned: number, detail: string | null = null) {
        this.database.prepare('UPDATE correction_cycles SET outcome=?,inspected=?,planned=?,detail=?,finishedAt=? WHERE id=?').run(outcome, inspected, planned, detail, new Date().toISOString(), cycleId);
    }
    createChange(connectionId: string, cycleId: string, mode: OperatingMode, change: PlannedChange, outcome: ChangeOutcome) {
        const changeId = randomUUID();
        this.database.prepare('INSERT INTO plot_changes VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL,?)').run(changeId, connectionId, cycleId, change.vehicleId, mode, outcome, new Date().toISOString(), JSON.stringify(change));
        return changeId;
    }
    finishChange(changeId: string, outcome: ChangeOutcome, httpStatus: number | null = null, detail: string | null = null) {
        this.database.prepare('UPDATE plot_changes SET outcome=?,httpStatus=?,detail=?,finishedAt=? WHERE id=?').run(outcome, httpStatus, detail, new Date().toISOString(), changeId);
    }
    private decodeChange(row: Record<string, unknown>): ChangeLog {
        const { changeData, ...metadata } = row;
        return { ...JSON.parse(String(changeData)), ...metadata } as ChangeLog;
    }
    listUnresolvedChanges(connectionId: string): ChangeLog[] {
        return this.database.prepare("SELECT * FROM plot_changes WHERE connectionId=? AND mode='live' AND outcome IN ('pending','unknown','unconfirmed')").all(connectionId).map(row => this.decodeChange(row));
    }
    saveZones(connectionId: string, zones: Zone[]) {
        const updatedAt = new Date().toISOString();
        this.database.exec('BEGIN');
        try {
            this.database.prepare('DELETE FROM autocab_zones WHERE connectionId=?').run(connectionId);
            const insertZone = this.database.prepare('INSERT INTO autocab_zones VALUES(?,?,?,?,?)');
            for (const zone of zones)
                insertZone.run(connectionId, zone.id, zone.name, zone.companyId, updatedAt);
            this.database.exec('COMMIT');
        }
        catch (error) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }
    getDashboard(connectionId: string | null = null): DashboardData {
        const filter = connectionId ? ' WHERE connectionId=?' : '';
        const parameters = connectionId ? [connectionId] : [];
        const changes = this.database.prepare('SELECT * FROM plot_changes' + filter + ' ORDER BY createdAt DESC,rowid DESC LIMIT 500').all(...parameters).map(row => this.decodeChange(row));
        const cycles = this.database.prepare('SELECT * FROM correction_cycles' + filter + ' ORDER BY startedAt DESC,rowid DESC LIMIT 100').all(...parameters) as unknown as CycleLog[];
        const zones = this.database.prepare('SELECT * FROM autocab_zones' + filter + ' ORDER BY connectionId,name').all(...parameters) as unknown as SavedZone[];
        const count = this.database.prepare('SELECT COUNT(*) AS total FROM plot_changes' + filter).get(...parameters);
        const messages = this.database.prepare('SELECT * FROM driver_messages' + filter + ' ORDER BY createdAt DESC,rowid DESC LIMIT 200').all(...parameters) as unknown as DriverMessageLog[];
        return { changes, cycles, zones, totalChanges: Number(count?.total ?? 0), messages };
    }
    getZoneQueueSignatures(connectionId: string) {
        const rows = this.database.prepare('SELECT zoneId,signature FROM zone_queue_signatures WHERE connectionId=?').all(connectionId);
        return new Map(rows.map(row => [Number(row.zoneId), String(row.signature)]));
    }
    saveZoneQueueSignature(connectionId: string, zoneId: number, signature: string) {
        this.database.prepare('INSERT INTO zone_queue_signatures VALUES(?,?,?,?) ON CONFLICT(connectionId,zoneId) DO UPDATE SET signature=excluded.signature,updatedAt=excluded.updatedAt').run(connectionId, zoneId, signature, new Date().toISOString());
    }
    listDriverMessages(connectionId: string | null = null, limit = 1000) {
        const filter = connectionId ? ' WHERE connectionId=?' : '';
        const parameters = connectionId ? [connectionId, limit] : [limit];
        return this.database.prepare('SELECT * FROM driver_messages' + filter + ' ORDER BY createdAt DESC,rowid DESC LIMIT ?').all(...parameters) as unknown as DriverMessageLog[];
    }
    recordDriverMessage(message: NewDriverMessage) {
        this.database.prepare('INSERT INTO driver_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), message.connectionId, message.cycleId, message.vehicleId, message.callsign, message.zoneId, message.zoneName, message.queuePosition, message.message, message.mode, message.outcome, message.httpStatus, new Date().toISOString());
    }
}
