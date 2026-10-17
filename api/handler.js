// Gerado por npm run build:api. Edite os arquivos TypeScript em server/.
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// server/postgres-schema.ts
var postgres_schema_exports = {};
__export(postgres_schema_exports, {
  postgresSchema: () => postgresSchema
});
var postgresSchema;
var init_postgres_schema = __esm({
  "server/postgres-schema.ts"() {
    "use strict";
    postgresSchema = `
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
);`;
  }
});

// server/serverless-handler.ts
import { timingSafeEqual } from "node:crypto";

// server/neon-runtime.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// server/execution-limits.ts
var CYCLE_TIME_BUDGET_MS = 27e4;
var CYCLE_LEASE_SECONDS = 360;

// server/neon-runtime.ts
import { Pool } from "pg";

// server/config.ts
import { readFileSync } from "node:fs";
var MULTICALL_COMPANIES = [
  { id: "arcoverde", name: "Arcoverde", companyIdEnvironmentVariable: "AUTOCAB_COMPANY_ID_ARCOVERDE" },
  { id: "sao-conrado", name: "S\xE3o Conrado", companyIdEnvironmentVariable: "AUTOCAB_COMPANY_ID_SAO_CONRADO" },
  { id: "pedra-da-gavea", name: "Pedra da G\xE1vea", companyIdEnvironmentVariable: "AUTOCAB_COMPANY_ID_PEDRA_DA_GAVEA" }
];
function readOptionalCompanyId(variableName) {
  const value = process.env[variableName]?.trim();
  if (!value)
    return void 0;
  const companyId = Number(value);
  if (!Number.isSafeInteger(companyId) || companyId < 0)
    throw new Error(`${variableName} deve ser um companyId num\xE9rico`);
  return companyId;
}
function readPositiveInteger(value, fallback) {
  const parsedValue = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 1)
    throw new Error("Configura\xE7\xE3o num\xE9rica inv\xE1lida");
  return parsedValue;
}
function readConnections() {
  if (!process.env.AUTOCAB_CONNECTIONS_FILE)
    return MULTICALL_COMPANIES.map((company) => ({ id: company.id, name: company.name, subscriptionKeyEnvironmentVariable: "AUTOCAB_SUBSCRIPTION_KEY", companyId: readOptionalCompanyId(company.companyIdEnvironmentVariable), companyName: company.name }));
  const connectionList = JSON.parse(readFileSync(process.env.AUTOCAB_CONNECTIONS_FILE, "utf8"));
  if (!Array.isArray(connectionList) || connectionList.length === 0)
    throw new Error("Lista de conex\xF5es vazia ou inv\xE1lida");
  const identifiers = /* @__PURE__ */ new Set();
  return connectionList.map((entry) => {
    if (typeof entry !== "object" || entry === null)
      throw new Error("Conex\xE3o inv\xE1lida");
    const connection = entry;
    if (typeof connection.id !== "string" || !/^[-a-zA-Z0-9_]+$/.test(connection.id) || identifiers.has(connection.id))
      throw new Error("ID de conex\xE3o inv\xE1lido ou duplicado");
    if (typeof connection.name !== "string" || !connection.name.trim())
      throw new Error("Nome de conex\xE3o ausente");
    if (typeof connection.subscriptionKeyEnvironmentVariable !== "string" || !/^AUTOCAB_[A-Z0-9_]+$/.test(connection.subscriptionKeyEnvironmentVariable))
      throw new Error("Nome da vari\xE1vel de chave inv\xE1lido");
    if (connection.companyId !== void 0 && (!Number.isSafeInteger(connection.companyId) || Number(connection.companyId) < 0))
      throw new Error("companyId inv\xE1lido");
    if (connection.companyName !== void 0 && (typeof connection.companyName !== "string" || !connection.companyName.trim()))
      throw new Error("companyName inv\xE1lido");
    identifiers.add(connection.id);
    return connection;
  });
}
function readConfiguration() {
  const mode = process.env.AUTOCAB_MODE || (process.env.VERCEL ? "dry" : "demo");
  if (!["demo", "dry", "live"].includes(mode))
    throw new Error("AUTOCAB_MODE deve ser demo, dry ou live");
  const host = process.env.HOST || "127.0.0.1";
  const panelToken = process.env.PANEL_TOKEN || "";
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !panelToken)
    throw new Error("Configure PANEL_TOKEN para acesso remoto");
  return {
    mode,
    baseUrl: process.env.AUTOCAB_BASE_URL || "https://autocab-api.azure-api.net",
    databasePath: process.env.DATABASE_PATH || "data/autocab.sqlite",
    host,
    port: readPositiveInteger(process.env.PORT, 3001),
    panelToken,
    intervalMs: Math.max(5e3, readPositiveInteger(process.env.CYCLE_INTERVAL_MS, 6e4)),
    autoStart: process.env.AUTO_START !== "false",
    protectedZoneNames: (process.env.PROTECTED_ZONES || "NAK,FORA DE AREA").split(",").map((name) => name.trim()).filter(Boolean),
    outsideZoneName: process.env.OUTSIDE_ZONE_NAME ?? "FORA DE AREA",
    companiesPath: process.env.AUTOCAB_COMPANIES_PATH || "/booking/v1/companies",
    connections: readConnections()
  };
}

// server/autocab.ts
var AutocabRequestError = class extends Error {
  httpStatus;
  constructor(message, httpStatus = null) {
    super(message);
    this.httpStatus = httpStatus;
  }
};
function requireObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new AutocabRequestError("Resposta Autocab cont\xE9m registro inv\xE1lido");
  return value;
}
function requireIdentifier(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new AutocabRequestError("Resposta Autocab cont\xE9m ID inv\xE1lido");
  return value;
}
function optionalIdentifier(value) {
  return value == null ? null : requireIdentifier(value);
}
function parseZone(value) {
  const zone = requireObject(value);
  const name = typeof zone.name === "string" && zone.name.trim() ? zone.name : zone.descriptor;
  if (typeof name !== "string" || !name.trim())
    throw new AutocabRequestError("Zona sem nome ou descriptor");
  return { id: requireIdentifier(zone.id), name, companyId: optionalIdentifier(zone.companyId) };
}
function parseCompany(value) {
  const company = requireObject(value);
  const name = [company.name, company.companyName, company.descriptor].find((candidate) => typeof candidate === "string" && candidate.trim());
  return { id: requireIdentifier(company.id ?? company.companyId), name: typeof name === "string" ? name : null };
}
function parseVehicle(value) {
  const vehicle = requireObject(value);
  return { id: requireIdentifier(vehicle.id), callsign: String(vehicle.callsign ?? vehicle.id), companyId: optionalIdentifier(vehicle.companyId) };
}
function parseVehicleStatus(value) {
  const status = requireObject(value);
  if (typeof status.vehicleStatusType !== "string" || !status.vehicleStatusType.trim() || !Object.hasOwn(status, "penalty"))
    throw new AutocabRequestError("Status sem vehicleStatusType ou penalty; confirme o contrato");
  return { vehicleId: requireIdentifier(status.id), zoneId: optionalIdentifier(status.zoneId), queuePosition: optionalIdentifier(status.queuePosition), status: status.vehicleStatusType, hasPenalty: status.penalty != null };
}
function parseGpsPosition(value) {
  const position = requireObject(value);
  const vehicleId = requireIdentifier(position.id ?? position.vehicleId);
  if (position.location == null)
    return null;
  const location = requireObject(position.location);
  if (typeof location.latitude !== "number" || typeof location.longitude !== "number")
    return null;
  if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude) || Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180)
    return null;
  if (location.latitude === 0 && location.longitude === 0)
    return null;
  return { vehicleId, latitude: location.latitude, longitude: location.longitude };
}
var AutocabClient = class {
  baseUrl;
  subscriptionKey;
  requestFetch;
  timeoutMs;
  companiesPath;
  constructor(baseUrl, subscriptionKey, requestFetch = fetch, timeoutMs = 15e3, companiesPath = "/booking/v1/companies") {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== "https:" || this.baseUrl.username || this.baseUrl.password)
      throw new Error("Base Autocab deve usar HTTPS sem credenciais na URL");
    if (!subscriptionKey)
      throw new Error("Subscription Key n\xE3o configurada");
    this.subscriptionKey = subscriptionKey;
    this.requestFetch = requestFetch;
    this.timeoutMs = timeoutMs;
    this.companiesPath = companiesPath;
  }
  async sendRequest(path, method = "GET", body) {
    const headers = { "Accept": "application/json", "Ocp-Apim-Subscription-Key": this.subscriptionKey };
    if (body !== void 0)
      headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await this.requestFetch(new URL(path, this.baseUrl), { method, headers, body: body === void 0 ? void 0 : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" });
    } catch {
      throw new AutocabRequestError("Falha de rede ou timeout na Autocab");
    }
    if (!response.ok)
      throw new AutocabRequestError(`Autocab respondeu HTTP ${response.status}`, response.status);
    return response;
  }
  async readJson(path) {
    const response = await this.sendRequest(path);
    try {
      return await response.json();
    } catch {
      throw new AutocabRequestError("Resposta Autocab n\xE3o \xE9 JSON v\xE1lido");
    }
  }
  async readArray(path) {
    const responseBody = await this.readJson(path);
    if (!Array.isArray(responseBody))
      throw new AutocabRequestError("Resposta Autocab n\xE3o \xE9 uma lista; confirme o contrato");
    return responseBody;
  }
  // Lista todas as empresas visíveis à chave. Sem o endpoint de empresas (404), usa os companyId
  // presentes em zonas e veículos; nesse caso os nomes ficam ausentes e o ID deve ser configurado.
  async listCompanies() {
    try {
      return (await this.readArray(this.companiesPath)).map(parseCompany);
    } catch (error) {
      if (!(error instanceof AutocabRequestError) || error.httpStatus !== 404)
        throw error;
    }
    const [zones, vehicles] = await Promise.all([this.listZones(), this.listVehicles()]);
    const companyIds = new Set([...zones, ...vehicles].map((record) => record.companyId).filter((companyId) => companyId !== null));
    return [...companyIds].sort((left, right) => left - right).map((id) => ({ id, name: null }));
  }
  async listZones() {
    return (await this.readArray("/booking/v1/zones")).map(parseZone);
  }
  async listVehicles() {
    return (await this.readArray("/vehicle/v1/vehicles")).map(parseVehicle);
  }
  async listVehicleStatuses() {
    return (await this.readArray("/vehicle/v1/vehiclestatuses")).map(parseVehicleStatus);
  }
  async listGpsPositions() {
    return (await this.readArray("/vehicle/v1/vehiclegpsposition")).map(parseGpsPosition).filter((position) => position !== null);
  }
  async findZoneByCoordinates(latitude, longitude, companyId) {
    const query = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude) });
    if (companyId !== void 0)
      query.set("companyId", String(companyId));
    const responseBody = await this.readJson("/booking/v1/zone?" + query);
    if (responseBody === null)
      return null;
    return optionalIdentifier(requireObject(responseBody).id);
  }
  async applyVehiclePlot(vehicleId, zoneId, position) {
    const response = await this.sendRequest(`/vehicle/v1/vehicles/${vehicleId}/plot`, "POST", { vehicleId, zoneId, position });
    await response.arrayBuffer();
    return response.status;
  }
};

// server/demo.ts
var DemoAutocabClient = class {
  statuses = [
    { vehicleId: 101, zoneId: 1, queuePosition: 1, status: "Available", hasPenalty: false },
    { vehicleId: 102, zoneId: 2, queuePosition: 1, status: "Busy", hasPenalty: false },
    { vehicleId: 103, zoneId: 1, queuePosition: 2, status: "Available", hasPenalty: true },
    { vehicleId: 104, zoneId: 3, queuePosition: 1, status: "Available", hasPenalty: false }
  ];
  async listCompanies() {
    return [{ id: 1, name: "Arcoverde" }, { id: 2, name: "S\xE3o Conrado" }, { id: 3, name: "Pedra da G\xE1vea" }];
  }
  async listZones() {
    return [{ id: 1, name: "Centro", companyId: 1 }, { id: 2, name: "Esta\xE7\xE3o", companyId: 1 }, { id: 3, name: "NAK", companyId: 1 }, { id: 4, name: "FORA DE AREA", companyId: 1 }];
  }
  async listVehicles() {
    return this.statuses.map((status) => ({ id: status.vehicleId, callsign: String(status.vehicleId), companyId: 1 }));
  }
  async listVehicleStatuses() {
    return structuredClone(this.statuses);
  }
  async listGpsPositions() {
    return this.statuses.map((status) => ({ vehicleId: status.vehicleId, latitude: -23.5, longitude: -46.6 }));
  }
  async findZoneByCoordinates(_latitude, _longitude, _companyId) {
    return 2;
  }
  async applyVehiclePlot(vehicleId, zoneId, position) {
    const vehicleStatus = this.statuses.find((status) => status.vehicleId === vehicleId);
    if (!vehicleStatus)
      throw new Error("Ve\xEDculo de demonstra\xE7\xE3o inexistente");
    vehicleStatus.zoneId = zoneId;
    vehicleStatus.queuePosition = position;
    return 200;
  }
};

// server/postgres-repository.ts
import { randomUUID } from "node:crypto";
init_postgres_schema();
var PostgresAuditRepository = class {
  database;
  constructor(database) {
    this.database = database;
  }
  async initialize() {
    await this.database.query(postgresSchema);
  }
  async recoverInterruptedCycles() {
    await this.database.query("UPDATE plot_changes SET outcome='unknown',detail='Execu\xE7\xE3o anterior interrompida; consultar antes de repetir' WHERE outcome='pending'");
    await this.database.query(`UPDATE correction_cycles SET outcome='interrupted',"finishedAt"=$1 WHERE outcome='running'`, [(/* @__PURE__ */ new Date()).toISOString()]);
  }
  async startCycle(connectionId, mode) {
    const cycleId = randomUUID();
    await this.database.query('INSERT INTO correction_cycles(id,"connectionId",mode,"startedAt",outcome) VALUES($1,$2,$3,$4,$5)', [cycleId, connectionId, mode, (/* @__PURE__ */ new Date()).toISOString(), "running"]);
    return cycleId;
  }
  async finishCycle(cycleId, outcome, inspected, planned, detail = null) {
    await this.database.query('UPDATE correction_cycles SET outcome=$1,inspected=$2,planned=$3,detail=$4,"finishedAt"=$5 WHERE id=$6', [outcome, inspected, planned, detail, (/* @__PURE__ */ new Date()).toISOString(), cycleId]);
  }
  async createChange(connectionId, cycleId, mode, change, outcome) {
    const changeId = randomUUID();
    await this.database.query('INSERT INTO plot_changes(id,"connectionId","cycleId","vehicleId",mode,outcome,"createdAt","changeData") VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [changeId, connectionId, cycleId, change.vehicleId, mode, outcome, (/* @__PURE__ */ new Date()).toISOString(), JSON.stringify(change)]);
    return changeId;
  }
  async finishChange(changeId, outcome, httpStatus = null, detail = null) {
    await this.database.query('UPDATE plot_changes SET outcome=$1,"httpStatus"=$2,detail=$3,"finishedAt"=$4 WHERE id=$5', [outcome, httpStatus, detail, (/* @__PURE__ */ new Date()).toISOString(), changeId]);
  }
  decodeChange(row) {
    const { changeData, ...metadata } = row;
    return { ...changeData, ...metadata, vehicleId: Number(row.vehicleId) };
  }
  async listUnresolvedChanges(connectionId) {
    const result = await this.database.query(`SELECT * FROM plot_changes WHERE "connectionId"=$1 AND mode='live' AND outcome IN ('pending','unknown','unconfirmed')`, [connectionId]);
    return result.rows.map((row) => this.decodeChange(row));
  }
  async saveZones(connectionId, zones) {
    await this.database.query(`WITH removed AS (
   DELETE FROM autocab_zones WHERE "connectionId"=$1 AND id NOT IN (SELECT (value->>'id')::bigint FROM jsonb_array_elements($2::jsonb))
  ) INSERT INTO autocab_zones("connectionId",id,name,"companyId","updatedAt")
   SELECT $1,(value->>'id')::bigint,value->>'name',(value->>'companyId')::bigint,$3 FROM jsonb_array_elements($2::jsonb)
   ON CONFLICT ("connectionId",id) DO UPDATE SET name=EXCLUDED.name,"companyId"=EXCLUDED."companyId","updatedAt"=EXCLUDED."updatedAt"`, [connectionId, JSON.stringify(zones), (/* @__PURE__ */ new Date()).toISOString()]);
  }
  async getDashboard(connectionId = null) {
    const filter = connectionId ? ' WHERE "connectionId"=$1' : "";
    const parameters = connectionId ? [connectionId] : [];
    const [changes, cycles, zones, count] = await Promise.all([
      this.database.query("SELECT * FROM plot_changes" + filter + ' ORDER BY "createdAt" DESC,id DESC LIMIT 500', parameters),
      this.database.query("SELECT * FROM correction_cycles" + filter + ' ORDER BY "startedAt" DESC,id DESC LIMIT 100', parameters),
      this.database.query("SELECT * FROM autocab_zones" + filter + ' ORDER BY "connectionId",name', parameters),
      this.database.query("SELECT COUNT(*) AS total FROM plot_changes" + filter, parameters)
    ]);
    return { changes: changes.rows.map((row) => this.decodeChange(row)), cycles: cycles.rows, zones: zones.rows.map((row) => ({ ...row, id: Number(row.id), companyId: row.companyId === null ? null : Number(row.companyId) })), totalChanges: Number(count.rows[0]?.total ?? 0) };
  }
  async acquireCycleLease(owner) {
    const result = await this.database.query(`INSERT INTO correction_lock(name,owner,"expiresAt") VALUES('autocab', $1, now()+($2::integer * interval '1 second'))
   ON CONFLICT(name) DO UPDATE SET owner=EXCLUDED.owner,"expiresAt"=EXCLUDED."expiresAt" WHERE correction_lock."expiresAt"<now() RETURNING owner`, [owner, CYCLE_LEASE_SECONDS]);
    return result.rows.length === 1;
  }
  async releaseCycleLease(owner) {
    await this.database.query("DELETE FROM correction_lock WHERE name=$1 AND owner=$2", ["autocab", owner]);
  }
  async getVehicleCursor(connectionId) {
    const result = await this.database.query('SELECT "vehicleId" FROM vehicle_cursors WHERE "connectionId"=$1', [connectionId]);
    return Number(result.rows[0]?.vehicleId ?? -1);
  }
  async saveVehicleCursor(connectionId, vehicleId) {
    await this.database.query('INSERT INTO vehicle_cursors("connectionId","vehicleId") VALUES($1,$2) ON CONFLICT("connectionId") DO UPDATE SET "vehicleId"=EXCLUDED."vehicleId"', [connectionId, vehicleId]);
  }
};

// server/rules.ts
function normalizeZoneName(name) {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
}
function isBusy(status) {
  return /busy|ocupad/i.test(status.status);
}
function isProtectedZone(zone, rules) {
  const zoneName = normalizeZoneName(zone.name);
  return rules.protectedZoneNames.some((protectedName) => zoneName.includes(normalizeZoneName(protectedName)));
}
function findOutsideZone(zones, rules) {
  if (!rules.outsideZoneName)
    return null;
  const matchingZones = zones.filter((zone) => normalizeZoneName(zone.name) === normalizeZoneName(rules.outsideZoneName));
  if (matchingZones.length !== 1)
    throw new Error("Zona FORA DE AREA configurada est\xE1 ausente ou amb\xEDgua nesta conex\xE3o/empresa");
  return matchingZones[0];
}
function chooseTargetZone(status, currentZone, gpsZone, outsideZone, rules) {
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
function calculateQueueTail(statuses, zoneId) {
  const zoneStatuses = statuses.filter((status) => status.zoneId === zoneId);
  const highestPosition = zoneStatuses.reduce((highest, status) => Math.max(highest, status.queuePosition ?? 0), 0);
  return Math.max(highestPosition, zoneStatuses.length);
}
function describeChange(status, currentZone, targetZone, callsign, gpsPosition, position) {
  return { vehicleId: status.vehicleId, callsign, previousZoneId: currentZone.id, previousZoneName: currentZone.name, targetZoneId: targetZone.id, targetZoneName: targetZone.name, position, reason: isBusy(status) ? "busy-outside" : "gps", latitude: gpsPosition?.latitude ?? null, longitude: gpsPosition?.longitude ?? null };
}

// server/correction-service.ts
async function resolveCompanyId(connection, gateway) {
  if (connection.companyId !== void 0 || connection.companyName === void 0)
    return connection.companyId;
  const companies = await gateway.listCompanies();
  const matchingCompanies = companies.filter((company) => company.name !== null && normalizeZoneName(company.name) === normalizeZoneName(connection.companyName));
  if (matchingCompanies.length !== 1) {
    const available = companies.map((company) => `${company.id}${company.name ? " " + company.name : ""}`).join(", ") || "nenhuma";
    throw new Error(`Empresa "${connection.companyName}" ${matchingCompanies.length ? "amb\xEDgua" : "n\xE3o encontrada"} no GET de empresas; configure o companyId. Dispon\xEDveis: ${available}`);
  }
  return matchingCompanies[0].id;
}
function safeErrorMessage(error) {
  return error instanceof Error ? error.message : "Falha n\xE3o identificada na corre\xE7\xE3o";
}
var CorrectionService = class {
  repository;
  rules;
  mode;
  deadline = Infinity;
  deferred = false;
  inspectedCount = 0;
  resolvedCompanyIds = /* @__PURE__ */ new Map();
  constructor(repository, rules, mode) {
    this.repository = repository;
    this.rules = rules;
    this.mode = mode;
  }
  async loadSnapshot(gateway) {
    const [zones, vehicles, statuses, gpsPositions] = await Promise.all([gateway.listZones(), gateway.listVehicles(), gateway.listVehicleStatuses(), gateway.listGpsPositions()]);
    if (new Set(zones.map((zone) => zone.id)).size !== zones.length)
      throw new Error("IDs de zonas duplicados na mesma conex\xE3o");
    if (new Set(statuses.map((status) => status.vehicleId)).size !== statuses.length)
      throw new Error("IDs de ve\xEDculos duplicados nos statuses");
    return { zones, vehicles, statuses, gpsPositions };
  }
  async reconcileUnresolvedChanges(connectionId, statuses) {
    for (const change of await this.repository.listUnresolvedChanges(connectionId)) {
      const currentStatus = statuses.find((status) => status.vehicleId === change.vehicleId);
      if (currentStatus?.zoneId === change.targetZoneId)
        await this.repository.finishChange(change.id, "confirmed", change.httpStatus, "Zona de destino confirmada em consulta posterior; posi\xE7\xE3o na fila pode ter avan\xE7ado.");
    }
  }
  async planChanges(connection, snapshot, gateway) {
    const blockedChanges = await this.repository.listUnresolvedChanges(connection.id);
    const blockedVehicles = new Set(blockedChanges.map((change) => change.vehicleId));
    const reservedQueuePositions = /* @__PURE__ */ new Map();
    for (const change of blockedChanges)
      reservedQueuePositions.set(change.targetZoneId, Math.max(reservedQueuePositions.get(change.targetZoneId) ?? 0, change.position));
    const plannedChanges = [];
    const cursor = await this.repository.getVehicleCursor?.(connection.id) ?? -1;
    const orderedStatuses = [...snapshot.statuses].sort((left, right) => left.vehicleId - right.vehicleId);
    const statusesAfterCursor = orderedStatuses.filter((status) => status.vehicleId > cursor);
    const statusesBeforeCursor = orderedStatuses.filter((status) => status.vehicleId <= cursor);
    const statusesToInspect = [...statusesAfterCursor, ...statusesBeforeCursor];
    for (const status of statusesToInspect) {
      if (Date.now() > this.deadline - 15e3) {
        this.deferred = true;
        break;
      }
      this.inspectedCount++;
      await this.repository.saveVehicleCursor?.(connection.id, status.vehicleId);
      if (status.hasPenalty || status.zoneId === null || blockedVehicles.has(status.vehicleId))
        continue;
      const vehicle = snapshot.vehicles.find((vehicle2) => vehicle2.id === status.vehicleId);
      if (!vehicle)
        continue;
      if (connection.companyId !== void 0) {
        if (vehicle.companyId === null)
          throw new Error("N\xE3o \xE9 poss\xEDvel filtrar empresa: ve\xEDculo sem companyId");
        if (vehicle.companyId !== connection.companyId)
          continue;
      }
      const companyId = connection.companyId ?? vehicle.companyId ?? void 0;
      const companyIds = new Set(snapshot.zones.map((zone) => zone.companyId).filter((companyId2) => companyId2 !== null));
      if (companyId === void 0 && companyIds.size > 1)
        throw new Error("V\xE1rias empresas nas zonas, mas ve\xEDculo sem companyId; configure uma conex\xE3o por empresa");
      const companyZones = snapshot.zones.filter((zone) => zone.companyId === null || companyId === void 0 || zone.companyId === companyId);
      const currentZone = companyZones.find((zone) => zone.id === status.zoneId);
      if (!currentZone)
        continue;
      const outsideZone = findOutsideZone(companyZones, this.rules);
      const gpsPosition = snapshot.gpsPositions.find((position) => position.vehicleId === status.vehicleId);
      let gpsZoneId = null;
      if (!isBusy(status) && gpsPosition)
        gpsZoneId = await gateway.findZoneByCoordinates(gpsPosition.latitude, gpsPosition.longitude, companyId);
      const gpsZone = companyZones.find((zone) => zone.id === gpsZoneId) ?? null;
      const targetZone = chooseTargetZone(status, currentZone, gpsZone, outsideZone, this.rules);
      if (!targetZone)
        continue;
      const queueTail = Math.max(calculateQueueTail(snapshot.statuses, targetZone.id), reservedQueuePositions.get(targetZone.id) ?? 0);
      reservedQueuePositions.set(targetZone.id, queueTail + 1);
      plannedChanges.push(describeChange(status, currentZone, targetZone, vehicle.callsign, gpsPosition, queueTail + 1));
    }
    return plannedChanges;
  }
  async verifyChange(gateway, change, changeId, httpStatus) {
    const latestStatus = (await gateway.listVehicleStatuses()).find((status) => status.vehicleId === change.vehicleId);
    const isConfirmed = latestStatus?.zoneId === change.targetZoneId;
    await this.repository.finishChange(changeId, isConfirmed ? "confirmed" : "unconfirmed", httpStatus, isConfirmed ? "Zona confirmada ap\xF3s envio; posi\xE7\xE3o enviada registrada no hist\xF3rico." : "POST aceito; zona ainda n\xE3o confirmada. Ve\xEDculo bloqueado para nova tentativa autom\xE1tica.");
  }
  async recordSendFailure(changeId, error) {
    const httpStatus = error instanceof AutocabRequestError ? error.httpStatus : null;
    const isDefiniteRejection = httpStatus !== null && httpStatus >= 400 && httpStatus < 500;
    await this.repository.finishChange(changeId, isDefiniteRejection ? "failed" : "unknown", httpStatus, isDefiniteRejection ? `Autocab rejeitou a altera\xE7\xE3o: HTTP ${httpStatus}.` : "Resultado incerto. Ve\xEDculo bloqueado at\xE9 uma consulta confirmar o destino.");
  }
  async executeChange(connection, cycleId, change, gateway, reservedPositions) {
    if (this.mode === "dry") {
      const changeId2 = await this.repository.createChange(connection.id, cycleId, this.mode, change, "planned");
      await this.repository.finishChange(changeId2, "planned", null, "Simula\xE7\xE3o com dados reais; nenhum POST enviado.");
      return;
    }
    const latestStatuses = await gateway.listVehicleStatuses();
    const latestStatus = latestStatuses.find((status) => status.vehicleId === change.vehicleId);
    const busyStateChanged = latestStatus ? isBusy(latestStatus) !== (change.reason === "busy-outside") : true;
    if (!latestStatus || latestStatus.hasPenalty || latestStatus.zoneId !== change.previousZoneId || busyStateChanged) {
      const changeId2 = await this.repository.createChange(connection.id, cycleId, this.mode, change, "skipped");
      await this.repository.finishChange(changeId2, "skipped", null, "Estado do ve\xEDculo mudou entre planejamento e envio.");
      return;
    }
    change.position = Math.max(change.position, calculateQueueTail(latestStatuses, change.targetZoneId) + 1, (reservedPositions.get(change.targetZoneId) ?? 0) + 1);
    reservedPositions.set(change.targetZoneId, change.position);
    const changeId = await this.repository.createChange(connection.id, cycleId, this.mode, change, "pending");
    try {
      const httpStatus = await gateway.applyVehiclePlot(change.vehicleId, change.targetZoneId, change.position);
      try {
        await this.verifyChange(gateway, change, changeId, httpStatus);
      } catch {
        await this.repository.finishChange(changeId, "unconfirmed", httpStatus, "POST aceito; consulta de confirma\xE7\xE3o falhou. N\xE3o repetir automaticamente.");
      }
    } catch (error) {
      await this.recordSendFailure(changeId, error);
    }
  }
  async runConnection(connection, options = {}) {
    this.deadline = options.deadline ?? Infinity;
    this.deferred = false;
    this.inspectedCount = 0;
    const cycleId = await this.repository.startCycle(connection.id, this.mode);
    let inspected = 0, planned = 0;
    try {
      if (!connection.gateway)
        throw new Error("Subscription Key ausente nesta conex\xE3o");
      const gateway = connection.gateway;
      if (connection.companyId === void 0 && connection.companyName !== void 0) {
        const companyId = this.resolvedCompanyIds.get(connection.id) ?? await resolveCompanyId(connection, gateway);
        if (companyId !== void 0)
          this.resolvedCompanyIds.set(connection.id, companyId);
        connection = { ...connection, companyId };
      }
      const snapshot = await this.loadSnapshot(gateway);
      if (connection.companyId !== void 0)
        snapshot.zones = snapshot.zones.filter((zone) => zone.companyId === null || zone.companyId === connection.companyId);
      await this.repository.saveZones(connection.id, snapshot.zones);
      if (this.mode === "live")
        await this.reconcileUnresolvedChanges(connection.id, snapshot.statuses);
      const changes = await this.planChanges(connection, snapshot, gateway);
      planned = changes.length;
      inspected = this.inspectedCount;
      const reservedPositions = /* @__PURE__ */ new Map();
      for (const change of changes) {
        if (Date.now() > this.deadline - 15e3) {
          this.deferred = true;
          await this.repository.saveVehicleCursor?.(connection.id, change.vehicleId - 1);
          break;
        }
        await this.executeChange(connection, cycleId, change, gateway, reservedPositions);
      }
      await this.repository.finishCycle(cycleId, this.deferred ? "partial" : "completed", inspected, planned, this.deferred ? "Tempo do ciclo esgotado; ve\xEDculos restantes ser\xE3o retomados no pr\xF3ximo ciclo." : null);
    } catch (error) {
      await this.repository.finishCycle(cycleId, "failed", this.inspectedCount, planned, safeErrorMessage(error));
    }
  }
};

// server/neon-runtime.ts
var CycleAlreadyRunningError = class extends Error {
};
var NeonCycleRunner = class {
  repository;
  service;
  connections;
  running = false;
  constructor(repository, service, connections) {
    this.repository = repository;
    this.service = service;
    this.connections = connections;
  }
  async runOnce() {
    if (this.running)
      throw new CycleAlreadyRunningError("Ciclo j\xE1 em andamento");
    this.running = true;
    const owner = randomUUID2();
    let acquired = false;
    try {
      acquired = await this.repository.acquireCycleLease(owner);
      if (!acquired)
        throw new CycleAlreadyRunningError("Outra inst\xE2ncia est\xE1 executando um ciclo");
      await this.repository.recoverInterruptedCycles();
      const deadline = Date.now() + CYCLE_TIME_BUDGET_MS;
      const nextConnectionIndex = await this.repository.getVehicleCursor(":connection-cursor");
      const startIndex = Math.max(0, nextConnectionIndex) % Math.max(1, this.connections.length);
      for (let offset = 0; offset < this.connections.length; offset++) {
        const connectionIndex = (startIndex + offset) % this.connections.length;
        const connection = this.connections[connectionIndex];
        if (Date.now() > deadline - 15e3)
          break;
        await this.service.runConnection(connection, { deadline });
        await this.repository.saveVehicleCursor(":connection-cursor", (connectionIndex + 1) % this.connections.length);
      }
    } finally {
      try {
        if (acquired)
          await this.repository.releaseCycleLease(owner);
      } finally {
        this.running = false;
      }
    }
  }
};
function createDatabasePool(databaseUrl) {
  const parsedUrl = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol))
    throw new Error("DATABASE_URL deve ser PostgreSQL");
  for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    parsedUrl.searchParams.delete(parameter);
  return new Pool({ connectionString: parsedUrl.toString(), ssl: { rejectUnauthorized: true }, max: 3, connectionTimeoutMillis: 5e3, query_timeout: 5e3, statement_timeout: 5e3, idleTimeoutMillis: 1e4 });
}
async function initializeDatabase(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(89120744)");
    const { postgresSchema: postgresSchema2 } = await Promise.resolve().then(() => (init_postgres_schema(), postgres_schema_exports));
    await client.query(postgresSchema2);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function createNeonRuntime() {
  if (!process.env.DATABASE_URL)
    throw new Error("Configure DATABASE_URL na Vercel");
  const configuration = readConfiguration();
  if (!configuration.panelToken)
    throw new Error("Configure PANEL_TOKEN para proteger o painel");
  const pool = createDatabasePool(process.env.DATABASE_URL);
  pool.on("error", () => console.error("Conex\xE3o com PostgreSQL interrompida"));
  const repository = new PostgresAuditRepository({ query: async (sql, parameters) => {
    const result = await pool.query(sql, parameters);
    return { rows: result.rows };
  } });
  try {
    await initializeDatabase(pool);
  } catch {
    await pool.end();
    throw new Error("N\xE3o foi poss\xEDvel preparar o Neon; confira DATABASE_URL e acesso ao banco");
  }
  const connections = configuration.connections.map((connection) => {
    const key = process.env[connection.subscriptionKeyEnvironmentVariable];
    const gateway = configuration.mode === "demo" ? new DemoAutocabClient() : key ? new AutocabClient(configuration.baseUrl, key, fetch, 4e3, configuration.companiesPath) : null;
    return { id: connection.id, name: connection.name, companyId: connection.companyId, companyName: connection.companyName, gateway };
  });
  const service = new CorrectionService(repository, configuration, configuration.mode);
  const runner = new NeonCycleRunner(repository, service, connections);
  return { configuration, repository, connections, runner, close: () => pool.end() };
}

// server/companies.ts
async function listCompaniesForConnections(connections) {
  const gateway = connections.find((connection) => connection.gateway !== null)?.gateway;
  if (!gateway)
    throw new Error("Subscription Key ausente; configure AUTOCAB_SUBSCRIPTION_KEY");
  const companies = await gateway.listCompanies();
  const selected = await Promise.all(connections.map(async (connection) => {
    try {
      const companyId = connection.gateway ? await resolveCompanyId(connection, connection.gateway) : void 0;
      return { connectionId: connection.id, name: connection.name, companyId: companyId ?? null, error: connection.gateway ? null : "Subscription Key ausente" };
    } catch (error) {
      return { connectionId: connection.id, name: connection.name, companyId: null, error: error instanceof Error ? error.message : "Falha ao resolver empresa" };
    }
  }));
  return { companies, selected };
}

// server/serverless-handler.ts
function hasBearerToken(request, token) {
  if (!token)
    return false;
  const supplied = Buffer.from(request.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}
function getRequestPath(request) {
  const url = new URL(request.url || "/", "http://internal");
  const rewrittenRoute = url.searchParams.get("route");
  return { path: rewrittenRoute ? "/api/" + rewrittenRoute : url.pathname, query: url.searchParams };
}
function hasValidOrigin(request) {
  if (!request.headers.origin)
    return true;
  try {
    return new URL(request.headers.origin).host === request.headers.host;
  } catch {
    return false;
  }
}
function createServerlessHandler(loadRuntime2) {
  return async (request, response) => {
    const { path, query } = getRequestPath(request);
    const isCron = path === "/api/cron";
    const expectedToken = isCron ? process.env.CRON_SECRET : process.env.PANEL_TOKEN;
    if (!expectedToken) {
      sendJson(response, 503, { error: `Configure ${isCron ? "CRON_SECRET" : "PANEL_TOKEN"} na Vercel e fa\xE7a Redeploy.` });
      return;
    }
    if (!hasBearerToken(request, expectedToken)) {
      sendJson(response, 401, { error: "Token inv\xE1lido ou ausente" });
      return;
    }
    if (request.method === "POST" && !hasValidOrigin(request)) {
      sendJson(response, 403, { error: "Origem n\xE3o permitida" });
      return;
    }
    const isRead = request.method === "GET" && (path === "/api/status" || path === "/api/dashboard" || path === "/api/companies");
    const isCycle = request.method === "GET" && isCron || request.method === "POST" && path === "/api/cycles";
    if (!isRead && !isCycle) {
      sendJson(response, 404, { error: "Rota n\xE3o encontrada" });
      return;
    }
    try {
      const runtime = await loadRuntime2();
      if (path === "/api/status") {
        sendJson(response, 200, { mode: runtime.configuration.mode, running: runtime.runner.running, autoStart: false, intervalMs: runtime.configuration.intervalMs, execution: "serverless", connections: runtime.connections.map((connection) => ({ id: connection.id, name: connection.name, configured: connection.gateway !== null, companyId: connection.companyId, companyName: connection.companyName })) });
        return;
      }
      if (path === "/api/companies") {
        try {
          sendJson(response, 200, await listCompaniesForConnections(runtime.connections));
        } catch (error) {
          sendJson(response, 502, { error: error instanceof Error ? error.message : "Falha ao consultar empresas" });
        }
        return;
      }
      if (path === "/api/dashboard") {
        sendJson(response, 200, await runtime.repository.getDashboard(query.get("connectionId")));
        return;
      }
      await runtime.runner.runOnce();
      sendJson(response, 200, { completed: true, note: "Consulte o hist\xF3rico de ciclos para resultados e lotes pendentes." });
    } catch (error) {
      if (error instanceof CycleAlreadyRunningError) {
        sendJson(response, 409, { error: "Ciclo j\xE1 em andamento em outra execu\xE7\xE3o" });
        return;
      }
      sendJson(response, 503, { error: "Falha ao acessar o backend. Confira DATABASE_URL e as configura\xE7\xF5es da Vercel." });
    }
  };
}
var runtimePromise = null;
function loadRuntime() {
  if (!runtimePromise)
    runtimePromise = createNeonRuntime().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  return runtimePromise;
}
var serverlessHandler = createServerlessHandler(loadRuntime);
export {
  serverlessHandler as default
};
