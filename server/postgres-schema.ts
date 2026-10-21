export const postgresSchema = `
CREATE TABLE IF NOT EXISTS plot_changes (
 id text PRIMARY KEY, "connectionId" text NOT NULL, "cycleId" text NOT NULL,
 "vehicleId" bigint NOT NULL, mode text NOT NULL, outcome text NOT NULL,
 "createdAt" text NOT NULL, "finishedAt" text, "httpStatus" integer, detail text,
 "changeData" jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS plot_changes_connection_time ON plot_changes("connectionId", "createdAt");
CREATE TABLE IF NOT EXISTS correction_cycles (
 id text PRIMARY KEY, "connectionId" text NOT NULL, mode text NOT NULL,
 "startedAt" text NOT NULL, "finishedAt" text, outcome text NOT NULL,
 inspected integer NOT NULL DEFAULT 0, planned integer NOT NULL DEFAULT 0, detail text
);
CREATE TABLE IF NOT EXISTS autocab_zones (
 "connectionId" text NOT NULL, id bigint NOT NULL, name text NOT NULL,
 "companyId" bigint, "updatedAt" text NOT NULL, PRIMARY KEY ("connectionId",id)
);
CREATE TABLE IF NOT EXISTS correction_lock (
 name text PRIMARY KEY, owner text NOT NULL, "expiresAt" timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicle_cursors (
 "connectionId" text PRIMARY KEY, "vehicleId" bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS zone_queue_signatures (
 "connectionId" text NOT NULL, "zoneId" bigint NOT NULL, signature text NOT NULL,
 "updatedAt" text NOT NULL, PRIMARY KEY ("connectionId","zoneId")
);
CREATE TABLE IF NOT EXISTS driver_messages (
 id text PRIMARY KEY, "connectionId" text NOT NULL, "cycleId" text NOT NULL,
 "vehicleId" bigint NOT NULL, callsign text NOT NULL, "zoneId" bigint NOT NULL, "zoneName" text NOT NULL,
 "queuePosition" integer NOT NULL, message text NOT NULL, mode text NOT NULL, outcome text NOT NULL,
 "httpStatus" integer, "createdAt" text NOT NULL
);
CREATE INDEX IF NOT EXISTS driver_messages_connection_time ON driver_messages("connectionId", "createdAt");`;
