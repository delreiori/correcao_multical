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
  }
});

// server/serverless-handler.ts
import { timingSafeEqual } from "node:crypto";

// server/neon-runtime.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// server/execution-limits.ts
var CYCLE_TIME_BUDGET_MS = 27e4;
var CYCLE_LEASE_SECONDS = 360;
var CRON_PASS_WINDOW_MS = 45e3;
function readCronRepeatIntervalMs(value = process.env.CRON_REPEAT_INTERVAL_MS) {
  const interval = Number(value ?? 2e4);
  return Number.isFinite(interval) && interval >= 0 ? interval : 2e4;
}

// server/neon-runtime.ts
import { Pool } from "pg";

// server/config.ts
import { readFileSync } from "node:fs";
var MULTICALL_COMPANIES = [
  // Arcoverde avisa por mensagem os motoristas livres de cada zona quando a fila muda.
  { id: "arcoverde", name: "Arcoverde", companyIdEnvironmentVariable: "AUTOCAB_COMPANY_ID_ARCOVERDE", driverMessages: true },
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
    return MULTICALL_COMPANIES.map((company) => ({ id: company.id, name: company.name, subscriptionKeyEnvironmentVariable: "AUTOCAB_SUBSCRIPTION_KEY", companyId: readOptionalCompanyId(company.companyIdEnvironmentVariable), companyName: company.name, driverMessages: company.driverMessages }));
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
    if (connection.driverMessages !== void 0 && typeof connection.driverMessages !== "boolean")
      throw new Error("driverMessages deve ser true ou false");
    identifiers.add(connection.id);
    return connection;
  });
}
function readDriverMessagesMode() {
  const mode = process.env.DRIVER_MESSAGES_MODE || "dry";
  if (!["off", "dry", "live"].includes(mode))
    throw new Error("DRIVER_MESSAGES_MODE deve ser off, dry ou live");
  return mode;
}
function readDriverMessageRecipients() {
  const value = (process.env.DRIVER_MESSAGES_ONLY ?? "").trim();
  if (value === "" || value === "*")
    return null;
  return value.split(",").map((recipient) => recipient.trim()).filter(Boolean);
}
function readDriverMessageFields() {
  const value = process.env.AUTOCAB_DRIVER_MESSAGE_FIELDS?.trim();
  if (!value)
    return { urgent: true };
  let fields;
  try {
    fields = JSON.parse(value);
  } catch {
    throw new Error('AUTOCAB_DRIVER_MESSAGE_FIELDS deve ser um JSON, ex.: {"urgent":true}');
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields))
    throw new Error('AUTOCAB_DRIVER_MESSAGE_FIELDS deve ser um objeto JSON, ex.: {"urgent":true}');
  return fields;
}
function readDriverMessagesRingback() {
  const value = (process.env.DRIVER_MESSAGES_RINGBACK ?? "").trim();
  if (value === "" || value.toLowerCase() === "off")
    return null;
  if (value.toLowerCase() === "all" || value === "*")
    return [];
  return value.split(",").map((recipient) => recipient.trim()).filter(Boolean);
}
function readDriverMessagePath() {
  const path = process.env.AUTOCAB_DRIVER_MESSAGE_PATH || "/vehicle/v1/vehicles/message";
  if (!path.startsWith("/"))
    throw new Error("AUTOCAB_DRIVER_MESSAGE_PATH deve come\xE7ar com /");
  return path;
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
    driverMessagesMode: readDriverMessagesMode(),
    driverMessagePath: readDriverMessagePath(),
    driverMessageFields: readDriverMessageFields(),
    driverMessageRecipients: readDriverMessageRecipients(),
    driverMessagesTop: readPositiveInteger(process.env.DRIVER_MESSAGES_TOP, 7),
    driverMessagesRingback: readDriverMessagesRingback(),
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
  driverMessagePath;
  driverMessageFields;
  constructor(baseUrl, subscriptionKey, requestFetch = fetch, timeoutMs = 15e3, options = {}) {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== "https:" || this.baseUrl.username || this.baseUrl.password)
      throw new Error("Base Autocab deve usar HTTPS sem credenciais na URL");
    if (!subscriptionKey)
      throw new Error("Subscription Key n\xE3o configurada");
    this.subscriptionKey = subscriptionKey;
    this.requestFetch = requestFetch;
    this.timeoutMs = timeoutMs;
    this.companiesPath = options.companiesPath ?? "/booking/v1/companies";
    this.driverMessagePath = options.driverMessagePath ?? "/vehicle/v1/vehicles/message";
    this.driverMessageFields = options.driverMessageFields ?? { urgent: true };
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
  // "Send Message to Vehicle(s)" da Vehicle API: mensagem da central para o terminal do motorista.
  async sendDriverMessage(vehicleId, message) {
    const response = await this.sendRequest(this.driverMessagePath, "POST", { text: message, vehicles: [vehicleId], companies: [], capabilities: [], zones: [], ...this.driverMessageFields });
    await response.arrayBuffer();
    return response.status;
  }
  // "RingBack A Vehicle": faz o terminal do motorista tocar. Única chamada sonora documentada na Vehicle API.
  async ringbackVehicle(vehicleId) {
    const response = await this.sendRequest(`/vehicle/v1/vehicles/${vehicleId}/ringback`, "POST", { VehicleId: vehicleId });
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
  sentMessages = [];
  async sendDriverMessage(vehicleId, message) {
    this.sentMessages.push({ vehicleId, message });
    return 200;
  }
  ringbacks = [];
  async ringbackVehicle(vehicleId) {
    this.ringbacks.push(vehicleId);
    return 200;
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
    const [changes, cycles, zones, count, messages] = await Promise.all([
      this.database.query("SELECT * FROM plot_changes" + filter + ' ORDER BY "createdAt" DESC,id DESC LIMIT 500', parameters),
      this.database.query("SELECT * FROM correction_cycles" + filter + ' ORDER BY "startedAt" DESC,id DESC LIMIT 100', parameters),
      this.database.query("SELECT * FROM autocab_zones" + filter + ' ORDER BY "connectionId",name', parameters),
      this.database.query("SELECT COUNT(*) AS total FROM plot_changes" + filter, parameters),
      this.database.query("SELECT * FROM driver_messages" + filter + ' ORDER BY "createdAt" DESC,id DESC LIMIT 200', parameters)
    ]);
    return { changes: changes.rows.map((row) => this.decodeChange(row)), cycles: cycles.rows, zones: zones.rows.map((row) => ({ ...row, id: Number(row.id), companyId: row.companyId === null ? null : Number(row.companyId) })), totalChanges: Number(count.rows[0]?.total ?? 0), messages: messages.rows.map((row) => ({ ...row, vehicleId: Number(row.vehicleId), zoneId: Number(row.zoneId) })) };
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
  async getZoneQueueSignatures(connectionId) {
    const result = await this.database.query('SELECT "zoneId",signature FROM zone_queue_signatures WHERE "connectionId"=$1', [connectionId]);
    return new Map(result.rows.map((row) => [Number(row.zoneId), String(row.signature)]));
  }
  async saveZoneQueueSignature(connectionId, zoneId, signature) {
    await this.database.query('INSERT INTO zone_queue_signatures("connectionId","zoneId",signature,"updatedAt") VALUES($1,$2,$3,$4) ON CONFLICT("connectionId","zoneId") DO UPDATE SET signature=EXCLUDED.signature,"updatedAt"=EXCLUDED."updatedAt"', [connectionId, zoneId, signature, (/* @__PURE__ */ new Date()).toISOString()]);
  }
  async listDriverMessages(connectionId = null, limit = 1e3) {
    const result = connectionId ? await this.database.query('SELECT * FROM driver_messages WHERE "connectionId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT $2', [connectionId, limit]) : await this.database.query('SELECT * FROM driver_messages ORDER BY "createdAt" DESC,id DESC LIMIT $1', [limit]);
    return result.rows.map((row) => ({ ...row, vehicleId: Number(row.vehicleId), zoneId: Number(row.zoneId) }));
  }
  async recordDriverMessage(message) {
    await this.database.query('INSERT INTO driver_messages(id,"connectionId","cycleId","vehicleId",callsign,"zoneId","zoneName","queuePosition",message,mode,outcome,"httpStatus","createdAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [randomUUID(), message.connectionId, message.cycleId, message.vehicleId, message.callsign, message.zoneId, message.zoneName, message.queuePosition, message.message, message.mode, message.outcome, message.httpStatus, (/* @__PURE__ */ new Date()).toISOString()]);
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
  if (matchingZones.length > 1)
    throw new Error("Zona FORA DE AREA configurada est\xE1 amb\xEDgua nesta conex\xE3o/empresa");
  return matchingZones[0] ?? null;
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

// server/driver-messages.ts
var MESSAGE_CONCURRENCY = 8;
function buildZoneQueues(zones, statuses, vehiclesById, rules) {
  return zones.filter((zone) => !isProtectedZone(zone, rules)).map((zone) => {
    const drivers = statuses.filter((status) => status.zoneId === zone.id && !isBusy(status) && vehiclesById.has(status.vehicleId)).sort((left, right) => (left.queuePosition ?? Infinity) - (right.queuePosition ?? Infinity) || left.vehicleId - right.vehicleId).map((status) => ({ vehicleId: status.vehicleId, callsign: vehiclesById.get(status.vehicleId).callsign }));
    return { zone, drivers };
  });
}
function queueSignature(queue) {
  return queue.drivers.map((driver) => driver.vehicleId).join(",");
}
function buildQueueMessage(companyName, queue, recipientIndex, listedDrivers = 7) {
  const listed = queue.drivers.slice(0, listedDrivers).map((driver, index) => `${index + 1}\xBA ${driver.callsign}`).join(" | ");
  const remaining = queue.drivers.length - listedDrivers;
  return `${companyName.toUpperCase()} - Fila ${queue.zone.name} atualizada. Voc\xEA \xE9 o ${recipientIndex + 1}\xBA. ${listed}${remaining > 0 ? ` | +${remaining}` : ""}`;
}
async function notifyQueueChanges(options) {
  const { store, gateway, connectionId } = options;
  if (options.messagesMode === "off" || !store.getZoneQueueSignatures || !store.saveZoneQueueSignature || !store.recordDriverMessage)
    return { zonesChanged: 0, messages: 0, failed: 0, ringbacks: 0, ringbacksFailed: 0 };
  const sendForReal = options.messagesMode === "live" && options.mode !== "demo";
  const allowed = options.recipients ? new Set(options.recipients) : null;
  const topDrivers = options.topDrivers ?? 7;
  const vehiclesById = new Map(options.vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const previousSignatures = await store.getZoneQueueSignatures(connectionId);
  let zonesChanged = 0, messages = 0, failed = 0, ringbacks = 0, ringbacksFailed = 0;
  const ringback = options.ringback ?? null;
  const shouldRingback = (driver) => ringback !== null && (ringback.length === 0 || ringback.includes(driver.callsign) || ringback.includes(String(driver.vehicleId)));
  for (const queue of buildZoneQueues(options.zones, options.statuses, vehiclesById, options.rules)) {
    const signature = queueSignature(queue);
    const previous = previousSignatures.get(queue.zone.id);
    if (previous === signature)
      continue;
    await store.saveZoneQueueSignature(connectionId, queue.zone.id, signature);
    if (previous === void 0 || queue.drivers.length === 0)
      continue;
    const previousPositions = new Map(previous.split(",").filter(Boolean).map((vehicleId, index) => [Number(vehicleId), index]));
    const recipients = queue.drivers.slice(0, topDrivers).map((driver, queuePosition) => ({ driver, queuePosition })).filter(({ driver, queuePosition }) => previousPositions.get(driver.vehicleId) !== queuePosition).filter(({ driver }) => !allowed || allowed.has(driver.callsign) || allowed.has(String(driver.vehicleId)));
    if (recipients.length === 0)
      continue;
    zonesChanged++;
    for (let start = 0; start < recipients.length; start += MESSAGE_CONCURRENCY) {
      await Promise.all(recipients.slice(start, start + MESSAGE_CONCURRENCY).map(async ({ driver, queuePosition }) => {
        const message = buildQueueMessage(options.companyName, queue, queuePosition, topDrivers);
        let outcome = "simulated", httpStatus = null;
        if (sendForReal) {
          try {
            httpStatus = await gateway.sendDriverMessage(driver.vehicleId, message);
            outcome = "sent";
            if (shouldRingback(driver)) {
              await gateway.ringbackVehicle(driver.vehicleId).then(() => ringbacks++, () => ringbacksFailed++);
            }
          } catch (error) {
            httpStatus = error instanceof AutocabRequestError ? error.httpStatus : null;
            outcome = "failed";
            failed++;
          }
        }
        messages++;
        await store.recordDriverMessage({ connectionId, cycleId: options.cycleId, vehicleId: driver.vehicleId, callsign: driver.callsign, zoneId: queue.zone.id, zoneName: queue.zone.name, queuePosition: queuePosition + 1, message, mode: options.mode, outcome, httpStatus });
      }));
    }
  }
  return { zonesChanged, messages, failed, ringbacks, ringbacksFailed };
}

// server/correction-service.ts
async function resolveCompanyId(connection, gateway) {
  if (connection.companyId !== void 0 || connection.companyName === void 0)
    return connection.companyId;
  const companies = await gateway.listCompanies();
  const wantedName = normalizeZoneName(connection.companyName);
  const namedCompanies = companies.filter((company) => company.name !== null);
  let matchingCompanies = namedCompanies.filter((company) => normalizeZoneName(company.name) === wantedName);
  if (matchingCompanies.length === 0)
    matchingCompanies = namedCompanies.filter((company) => normalizeZoneName(company.name).includes(wantedName));
  if (matchingCompanies.length !== 1) {
    const available = companies.map((company) => `${company.id}${company.name ? " " + company.name : ""}`).join(", ") || "nenhuma";
    throw new Error(`Empresa "${connection.companyName}" ${matchingCompanies.length ? "amb\xEDgua" : "n\xE3o encontrada"} no GET de empresas; configure o companyId. Dispon\xEDveis: ${available}`);
  }
  return matchingCompanies[0].id;
}
var GPS_LOOKUP_CONCURRENCY = 8;
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
  notes = [];
  resolvedCompanyIds = /* @__PURE__ */ new Map();
  driverMessagesMode;
  driverMessageRecipients;
  driverMessagesTop;
  driverMessagesRingback;
  constructor(repository, rules, mode, driverMessagesMode = "off", driverMessageRecipients = null, driverMessagesTop = 7, driverMessagesRingback = null) {
    this.repository = repository;
    this.rules = rules;
    this.mode = mode;
    this.driverMessagesMode = driverMessagesMode;
    this.driverMessageRecipients = driverMessageRecipients;
    this.driverMessagesTop = driverMessagesTop;
    this.driverMessagesRingback = driverMessagesRingback;
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
    const vehiclesById = new Map(snapshot.vehicles.map((vehicle) => [vehicle.id, vehicle]));
    let statusesToInspect = [...statusesAfterCursor, ...statusesBeforeCursor];
    if (connection.companyId !== void 0) {
      const withoutCompany = statusesToInspect.filter((status) => vehiclesById.get(status.vehicleId)?.companyId == null).length;
      statusesToInspect = statusesToInspect.filter((status) => vehiclesById.get(status.vehicleId)?.companyId === connection.companyId);
      this.notes.push(`companyId ${connection.companyId}: ${statusesToInspect.length} ve\xEDculos da empresa de ${snapshot.statuses.length} retornados`);
      if (withoutCompany > 0)
        this.notes.push(`${withoutCompany} ve\xEDculos sem companyId ignorados`);
    }
    const companyId = connection.companyId;
    const outsideZoneMissing = companyId !== void 0 && this.rules.outsideZoneName !== "" && findOutsideZone(snapshot.zones, this.rules) === null;
    if (outsideZoneMissing)
      this.notes.push(`zona ${this.rules.outsideZoneName} n\xE3o existe nesta empresa; ocupados n\xE3o s\xE3o movidos`);
    const zoneCompanyIds = new Set(snapshot.zones.map((zone) => zone.companyId).filter((zoneCompanyId) => zoneCompanyId !== null));
    const gpsByVehicle = new Map(snapshot.gpsPositions.map((position) => [position.vehicleId, position]));
    for (let start = 0; start < statusesToInspect.length; start += GPS_LOOKUP_CONCURRENCY) {
      if (Date.now() > this.deadline - 15e3) {
        this.deferred = true;
        break;
      }
      const chunk = statusesToInspect.slice(start, start + GPS_LOOKUP_CONCURRENCY);
      const candidates = await Promise.all(chunk.map(async (status) => {
        if (status.hasPenalty || status.zoneId === null || blockedVehicles.has(status.vehicleId))
          return null;
        const vehicle = vehiclesById.get(status.vehicleId);
        if (!vehicle)
          return null;
        const vehicleCompanyId = companyId ?? vehicle.companyId ?? void 0;
        if (vehicleCompanyId === void 0 && zoneCompanyIds.size > 1)
          throw new Error("V\xE1rias empresas nas zonas, mas ve\xEDculo sem companyId; configure uma conex\xE3o por empresa");
        const companyZones = snapshot.zones.filter((zone) => zone.companyId === null || vehicleCompanyId === void 0 || zone.companyId === vehicleCompanyId);
        const currentZone = companyZones.find((zone) => zone.id === status.zoneId);
        if (!currentZone)
          return null;
        const gpsPosition = gpsByVehicle.get(status.vehicleId);
        const gpsZoneId = !isBusy(status) && gpsPosition ? await gateway.findZoneByCoordinates(gpsPosition.latitude, gpsPosition.longitude, vehicleCompanyId) : null;
        return { status, vehicle, companyZones, currentZone, gpsPosition, gpsZoneId };
      }));
      for (const candidate of candidates) {
        if (!candidate)
          continue;
        const { status, vehicle, companyZones, currentZone, gpsPosition, gpsZoneId } = candidate;
        const gpsZone = companyZones.find((zone) => zone.id === gpsZoneId) ?? null;
        const targetZone = chooseTargetZone(status, currentZone, gpsZone, findOutsideZone(companyZones, this.rules), this.rules);
        if (!targetZone)
          continue;
        const queueTail = Math.max(calculateQueueTail(snapshot.statuses, targetZone.id), reservedQueuePositions.get(targetZone.id) ?? 0);
        reservedQueuePositions.set(targetZone.id, queueTail + 1);
        plannedChanges.push(describeChange(status, currentZone, targetZone, vehicle.callsign, gpsPosition, queueTail + 1));
      }
      this.inspectedCount += chunk.length;
      await this.repository.saveVehicleCursor?.(connection.id, chunk[chunk.length - 1].vehicleId);
    }
    return plannedChanges;
  }
  // Uma consulta de status confirma todos os envios do lote.
  // Devolve os status lidos após os envios, reaproveitados no aviso de fila aos motoristas.
  async verifySentChanges(gateway, sentChanges) {
    if (sentChanges.length === 0)
      return null;
    let statusList;
    try {
      statusList = await gateway.listVehicleStatuses();
    } catch {
      for (const { changeId, httpStatus } of sentChanges)
        await this.repository.finishChange(changeId, "unconfirmed", httpStatus, "POST aceito; consulta de confirma\xE7\xE3o falhou. N\xE3o repetir automaticamente.");
      return null;
    }
    const latestStatuses = new Map(statusList.map((status) => [status.vehicleId, status]));
    for (const { change, changeId, httpStatus } of sentChanges) {
      const isConfirmed = latestStatuses.get(change.vehicleId)?.zoneId === change.targetZoneId;
      await this.repository.finishChange(changeId, isConfirmed ? "confirmed" : "unconfirmed", httpStatus, isConfirmed ? "Zona confirmada ap\xF3s envio; posi\xE7\xE3o enviada registrada no hist\xF3rico." : "POST aceito; zona ainda n\xE3o confirmada. Ve\xEDculo bloqueado para nova tentativa autom\xE1tica.");
    }
    return statusList;
  }
  async recordSendFailure(changeId, error) {
    const httpStatus = error instanceof AutocabRequestError ? error.httpStatus : null;
    const isDefiniteRejection = httpStatus !== null && httpStatus >= 400 && httpStatus < 500;
    await this.repository.finishChange(changeId, isDefiniteRejection ? "failed" : "unknown", httpStatus, isDefiniteRejection ? `Autocab rejeitou a altera\xE7\xE3o: HTTP ${httpStatus}.` : "Resultado incerto. Ve\xEDculo bloqueado at\xE9 uma consulta confirmar o destino.");
  }
  async executeChange(connection, cycleId, change, gateway, latestStatuses, reservedPositions, sentChanges) {
    if (this.mode === "dry") {
      const changeId2 = await this.repository.createChange(connection.id, cycleId, this.mode, change, "planned");
      await this.repository.finishChange(changeId2, "planned", null, "Simula\xE7\xE3o com dados reais; nenhum POST enviado.");
      return;
    }
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
      sentChanges.push({ change, changeId, httpStatus });
    } catch (error) {
      await this.recordSendFailure(changeId, error);
    }
  }
  async runConnection(connection, options = {}) {
    this.deadline = options.deadline ?? Infinity;
    this.deferred = false;
    this.inspectedCount = 0;
    this.notes = [];
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
      let snapshotPromise = options.snapshotCache?.get(gateway);
      if (!snapshotPromise) {
        snapshotPromise = this.loadSnapshot(gateway);
        options.snapshotCache?.set(gateway, snapshotPromise);
        snapshotPromise.catch(() => options.snapshotCache?.delete(gateway));
      }
      let snapshot = await snapshotPromise;
      if (connection.companyId !== void 0)
        snapshot = { ...snapshot, zones: snapshot.zones.filter((zone) => zone.companyId === null || zone.companyId === connection.companyId) };
      await this.repository.saveZones(connection.id, snapshot.zones);
      if (this.mode === "live")
        await this.reconcileUnresolvedChanges(connection.id, snapshot.statuses);
      const changes = await this.planChanges(connection, snapshot, gateway);
      planned = changes.length;
      inspected = this.inspectedCount;
      const reservedPositions = /* @__PURE__ */ new Map();
      const sentChanges = [];
      const latestStatuses = this.mode === "live" && changes.length > 0 ? await gateway.listVehicleStatuses() : [];
      let statusesAfterSend = null;
      try {
        for (const change of changes) {
          if (Date.now() > this.deadline - 15e3) {
            this.deferred = true;
            await this.repository.saveVehicleCursor?.(connection.id, change.vehicleId - 1);
            break;
          }
          await this.executeChange(connection, cycleId, change, gateway, latestStatuses, reservedPositions, sentChanges);
        }
      } finally {
        statusesAfterSend = await this.verifySentChanges(gateway, sentChanges);
      }
      if (connection.driverMessages && connection.companyId !== void 0) {
        try {
          const result = await notifyQueueChanges({ store: this.repository, gateway, connectionId: connection.id, companyName: connection.companyName ?? connection.name, cycleId, mode: this.mode, messagesMode: this.driverMessagesMode, zones: snapshot.zones, statuses: statusesAfterSend ?? snapshot.statuses, vehicles: snapshot.vehicles.filter((vehicle) => vehicle.companyId === connection.companyId), rules: this.rules, recipients: this.driverMessageRecipients, topDrivers: this.driverMessagesTop, ringback: this.driverMessagesRingback });
          if (result.messages > 0)
            this.notes.push(`avisos de fila: ${result.zonesChanged} zonas, ${result.messages} mensagens${result.failed ? `, ${result.failed} falharam` : ""}${result.ringbacks + result.ringbacksFailed ? `; ringback ${result.ringbacks} ok${result.ringbacksFailed ? `, ${result.ringbacksFailed} falharam` : ""}` : ""}`);
        } catch (error) {
          this.notes.push(`avisos de fila n\xE3o enviados: ${safeErrorMessage(error)}`);
        }
      }
      if (this.deferred)
        this.notes.push("Tempo do ciclo esgotado; ve\xEDculos restantes ser\xE3o retomados no pr\xF3ximo ciclo.");
      const outcome = this.deferred ? "partial" : "completed";
      await this.repository.finishCycle(cycleId, outcome, inspected, planned, this.notes.join(". ") || null);
      return outcome;
    } catch (error) {
      await this.repository.finishCycle(cycleId, "failed", this.inspectedCount, planned, safeErrorMessage(error));
      return "failed";
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
  // Indica se a última execução terminou todas as empresas sem lote parcial nem falha.
  lastRunCompleted = false;
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
    this.lastRunCompleted = false;
    try {
      acquired = await this.repository.acquireCycleLease(owner);
      if (!acquired)
        throw new CycleAlreadyRunningError("Outra inst\xE2ncia est\xE1 executando um ciclo");
      await this.repository.recoverInterruptedCycles();
      const deadline = Date.now() + CYCLE_TIME_BUDGET_MS;
      const snapshotCache = /* @__PURE__ */ new Map();
      let completedConnections = 0;
      const nextConnectionIndex = await this.repository.getVehicleCursor(":connection-cursor");
      const startIndex = Math.max(0, nextConnectionIndex) % Math.max(1, this.connections.length);
      for (let offset = 0; offset < this.connections.length; offset++) {
        const connectionIndex = (startIndex + offset) % this.connections.length;
        const connection = this.connections[connectionIndex];
        if (Date.now() > deadline - 15e3)
          break;
        const remainingConnections = this.connections.length - offset;
        const connectionDeadline = Date.now() + (deadline - Date.now()) / remainingConnections;
        if (await this.service.runConnection(connection, { deadline: connectionDeadline, snapshotCache }) === "completed")
          completedConnections++;
        await this.repository.saveVehicleCursor(":connection-cursor", (connectionIndex + 1) % this.connections.length);
      }
      this.lastRunCompleted = completedConnections === this.connections.length;
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
    const gateway = configuration.mode === "demo" ? new DemoAutocabClient() : key ? new AutocabClient(configuration.baseUrl, key, fetch, 4e3, { companiesPath: configuration.companiesPath, driverMessagePath: configuration.driverMessagePath, driverMessageFields: configuration.driverMessageFields }) : null;
    return { id: connection.id, name: connection.name, companyId: connection.companyId, companyName: connection.companyName, driverMessages: connection.driverMessages, gateway };
  });
  const service = new CorrectionService(repository, configuration, configuration.mode, configuration.driverMessagesMode, configuration.driverMessageRecipients, configuration.driverMessagesTop, configuration.driverMessagesRingback);
  const runner = new NeonCycleRunner(repository, service, connections);
  return { configuration, repository, connections, runner, close: () => pool.end() };
}

// server/companies.ts
async function listCompaniesForConnections(connections) {
  const gateway = connections.find((connection) => connection.gateway !== null)?.gateway;
  if (!gateway)
    throw new Error("Subscription Key ausente; configure AUTOCAB_SUBSCRIPTION_KEY");
  const [companyList, vehicles, zones] = await Promise.all([gateway.listCompanies(), gateway.listVehicles(), gateway.listZones()]);
  const companies = companyList.map((company) => ({ ...company, vehicles: vehicles.filter((vehicle) => vehicle.companyId === company.id).length, zones: zones.filter((zone) => zone.companyId === company.id).length }));
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
      const message = `Configure ${isCron ? "CRON_SECRET" : "PANEL_TOKEN"} na Vercel e fa\xE7a Redeploy.`;
      console.error(message);
      sendJson(response, 503, { error: message });
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
    const isRead = request.method === "GET" && (path === "/api/status" || path === "/api/dashboard" || path === "/api/companies" || path === "/api/messages");
    const isCycle = request.method === "GET" && isCron || request.method === "POST" && path === "/api/cycles";
    if (!isRead && !isCycle) {
      sendJson(response, 404, { error: "Rota n\xE3o encontrada" });
      return;
    }
    let runtime;
    try {
      runtime = await loadRuntime2();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao iniciar o backend";
      console.error(`Backend n\xE3o iniciou: ${message}`);
      sendJson(response, 503, { error: `${message}. Confira as vari\xE1veis da Vercel e fa\xE7a Redeploy.` });
      return;
    }
    try {
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
      if (path === "/api/messages") {
        sendJson(response, 200, { messages: await runtime.repository.listDriverMessages(query.get("connectionId")) });
        return;
      }
      if (path === "/api/dashboard") {
        sendJson(response, 200, await runtime.repository.getDashboard(query.get("connectionId")));
        return;
      }
      const startedAt = Date.now();
      await runtime.runner.runOnce();
      if (isCron) {
        const repeatIntervalMs = readCronRepeatIntervalMs();
        while (repeatIntervalMs > 0 && runtime.runner.lastRunCompleted && Date.now() - startedAt + repeatIntervalMs < CRON_PASS_WINDOW_MS) {
          await new Promise((resolve) => setTimeout(resolve, repeatIntervalMs));
          await runtime.runner.runOnce();
        }
      }
      sendJson(response, 200, { completed: true, note: "Consulte o hist\xF3rico de ciclos para resultados e lotes pendentes." });
    } catch (error) {
      if (error instanceof CycleAlreadyRunningError) {
        sendJson(response, 409, { error: "Ciclo j\xE1 em andamento em outra execu\xE7\xE3o" });
        return;
      }
      console.error("Falha ao executar a rota no backend");
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
