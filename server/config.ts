import { readFileSync } from 'node:fs';
import type { OperatingMode } from '../shared/types.ts';
export interface ConnectionConfig {
    id: string;
    name: string;
    subscriptionKeyEnvironmentVariable: string;
    companyId?: number;
    companyName?: string;
    driverMessages?: boolean;
    // Ocupado acompanha a zona do GPS e não segura posição à frente dos livres (Arcoverde).
    busyFollowsGps?: boolean;
    // Todo carro não livre vai para fora de área, menos NAK e sem GPS (Arcoverde).
    allNotFreeToOutside?: boolean;
    // Carros cujo callsign começa com estes prefixos são desta empresa, qualquer que seja o companyId
    // do cadastro (Arcoverde: "5"). As outras empresas deixam esses carros de lado.
    callsignPrefixes?: string[];
    excludeCallsignPrefixes?: string[];
    // Zonas de ponto: livre com GPS dentro do contorno (ou a até radiusMeters dele) é colocado nelas e avisado (Arcoverde: PA1, só dentro).
    pointZones?: { name: string; radiusMeters: number }[];
}
export type DriverMessagesMode = 'off' | 'dry' | 'live';
export interface AppConfig {
    mode: OperatingMode;
    baseUrl: string;
    databasePath: string;
    host: string;
    port: number;
    panelToken: string;
    intervalMs: number;
    autoStart: boolean;
    protectedZoneNames: string[];
    outsideZoneName: string;
    companiesPath: string;
    // Tempo máximo de cada requisição à Autocab.
    autocabTimeoutMs: number;
    driverMessagesMode: DriverMessagesMode;
    reservationMessagesMode?: DriverMessagesMode;
    driverMessagePath: string;
    driverMessageFields: Record<string, unknown>;
    // Callsigns ou IDs que recebem os avisos; null = todos os motoristas livres da zona.
    driverMessageRecipients: string[] | null;
    // Limita o aviso aos N primeiros da fila; null (padrão) = todos.
    driverMessagesTop: number | null;
    connections: ConnectionConfig[];
}
// Empresas da Multicall corrigidas por padrão. Todas usam a mesma Subscription Key; o rastreio
// de cada uma fica separado pelo companyId, informado na variável ou resolvido pelo nome no GET de empresas.
export const MULTICALL_COMPANIES = [
    // Arcoverde avisa por mensagem os motoristas livres de cada zona quando a fila muda. Ocupado vai
    // para FORA DE AREA e só sai quando fica livre (regra padrão, sem busyFollowsGps).
    { id: 'arcoverde', name: 'Arcoverde', companyIdEnvironmentVariable: 'AUTOCAB_COMPANY_ID_ARCOVERDE', driverMessages: true, allNotFreeToOutside: true, callsignPrefixes: ['5'], pointZones: [{ name: 'PA1', radiusMeters: 0 }] },
    { id: 'sao-conrado', name: 'São Conrado', companyIdEnvironmentVariable: 'AUTOCAB_COMPANY_ID_SAO_CONRADO' },
    { id: 'pedra-da-gavea', name: 'Pedra da Gávea', companyIdEnvironmentVariable: 'AUTOCAB_COMPANY_ID_PEDRA_DA_GAVEA' },
];
function readOptionalCompanyId(variableName: string): number | undefined {
    const value = process.env[variableName]?.trim();
    if (!value)
        return undefined;
    const companyId = Number(value);
    if (!Number.isSafeInteger(companyId) || companyId < 0)
        throw new Error(`${variableName} deve ser um companyId numérico`);
    return companyId;
}
function readPositiveInteger(value: string | undefined, fallback: number): number {
    const parsedValue = Number(value ?? fallback);
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 1)
        throw new Error('Configuração numérica inválida');
    return parsedValue;
}
function readConnections(): ConnectionConfig[] {
    if (!process.env.AUTOCAB_CONNECTIONS_FILE)
        return withPrefixExclusions(MULTICALL_COMPANIES.map(company => ({ id: company.id, name: company.name, subscriptionKeyEnvironmentVariable: 'AUTOCAB_SUBSCRIPTION_KEY', companyId: readOptionalCompanyId(company.companyIdEnvironmentVariable), companyName: company.name, driverMessages: company.driverMessages, allNotFreeToOutside: 'allNotFreeToOutside' in company && company.allNotFreeToOutside === true ? true : undefined, callsignPrefixes: 'callsignPrefixes' in company ? company.callsignPrefixes : undefined, pointZones: 'pointZones' in company && company.pointZones ? readPointZones(company.pointZones) : undefined })));
    const connectionList: unknown = JSON.parse(readFileSync(process.env.AUTOCAB_CONNECTIONS_FILE, 'utf8'));
    if (!Array.isArray(connectionList) || connectionList.length === 0)
        throw new Error('Lista de conexões vazia ou inválida');
    const identifiers = new Set<string>();
    return withPrefixExclusions(connectionList.map((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null)
            throw new Error('Conexão inválida');
        const connection = entry as Record<string, unknown>;
        if (typeof connection.id !== 'string' || !/^[-a-zA-Z0-9_]+$/.test(connection.id) || identifiers.has(connection.id))
            throw new Error('ID de conexão inválido ou duplicado');
        if (typeof connection.name !== 'string' || !connection.name.trim())
            throw new Error('Nome de conexão ausente');
        if (typeof connection.subscriptionKeyEnvironmentVariable !== 'string' || !/^AUTOCAB_[A-Z0-9_]+$/.test(connection.subscriptionKeyEnvironmentVariable))
            throw new Error('Nome da variável de chave inválido');
        if (connection.companyId !== undefined && (!Number.isSafeInteger(connection.companyId) || Number(connection.companyId) < 0))
            throw new Error('companyId inválido');
        if (connection.companyName !== undefined && (typeof connection.companyName !== 'string' || !connection.companyName.trim()))
            throw new Error('companyName inválido');
        if (connection.driverMessages !== undefined && typeof connection.driverMessages !== 'boolean')
            throw new Error('driverMessages deve ser true ou false');
        if (connection.busyFollowsGps !== undefined && typeof connection.busyFollowsGps !== 'boolean')
            throw new Error('busyFollowsGps deve ser true ou false');
        if (connection.allNotFreeToOutside !== undefined && typeof connection.allNotFreeToOutside !== 'boolean')
            throw new Error('allNotFreeToOutside deve ser true ou false');
        if (connection.callsignPrefixes !== undefined && (!Array.isArray(connection.callsignPrefixes) || connection.callsignPrefixes.some(prefix => typeof prefix !== 'string' || !prefix.trim())))
            throw new Error('callsignPrefixes deve ser uma lista de prefixos');
        identifiers.add(connection.id);
        return connection as unknown as ConnectionConfig;
    }));
}
// POINT_ZONES (ex.: "PA1:80,PA2:60") troca as zonas de ponto padrão da empresa; "off" desliga.
function readPointZones(defaults: { name: string; radiusMeters: number }[]) {
    const value = process.env.POINT_ZONES?.trim();
    if (!value)
        return defaults;
    if (value.toLowerCase() === 'off')
        return [];
    return value.split(',').map(entry => entry.trim()).filter(Boolean).map(entry => {
        const [name, radius] = entry.split(':');
        const radiusMeters = Number(radius ?? 0);
        if (!name?.trim() || !Number.isFinite(radiusMeters) || radiusMeters < 0)
            throw new Error('POINT_ZONES deve ser como "PA1:80,PA2:60"');
        return { name: name.trim(), radiusMeters };
    });
}
// Cada empresa deixa de lado os carros com prefixo de callsign de outra empresa.
function withPrefixExclusions(connections: ConnectionConfig[]): ConnectionConfig[] {
    return connections.map(connection => {
        const excludeCallsignPrefixes = connections.filter(other => other.id !== connection.id).flatMap(other => other.callsignPrefixes ?? []);
        return excludeCallsignPrefixes.length > 0 ? { ...connection, excludeCallsignPrefixes } : connection;
    });
}
function readDriverMessagesMode(): DriverMessagesMode {
    // Ligado por padrão; só não envia de verdade no modo demo (veja notifyQueueChanges).
    const mode = process.env.DRIVER_MESSAGES_MODE || 'live';
    if (!['off', 'dry', 'live'].includes(mode))
        throw new Error('DRIVER_MESSAGES_MODE deve ser off, dry ou live');
    return mode as DriverMessagesMode;
}
// Por padrão todos os motoristas livres da zona recebem. DRIVER_MESSAGES_ONLY restringe a uma lista
// de callsigns/IDs, útil para testes (ex.: 5013).
function readDriverMessageRecipients(): string[] | null {
    const value = (process.env.DRIVER_MESSAGES_ONLY ?? '').trim();
    if (value === '' || value === '*')
        return null;
    return value.split(',').map(recipient => recipient.trim()).filter(Boolean);
}
// A especificação não documenta o campo de urgência; o padrão é { "urgent": true } e pode ser trocado
// em AUTOCAB_DRIVER_MESSAGE_FIELDS (JSON) sem novo deploy de código.
function readDriverMessageFields(): Record<string, unknown> {
    const value = process.env.AUTOCAB_DRIVER_MESSAGE_FIELDS?.trim();
    if (!value)
        return { urgent: true };
    let fields: unknown;
    try {
        fields = JSON.parse(value);
    }
    catch {
        throw new Error('AUTOCAB_DRIVER_MESSAGE_FIELDS deve ser um JSON, ex.: {"urgent":true}');
    }
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields))
        throw new Error('AUTOCAB_DRIVER_MESSAGE_FIELDS deve ser um objeto JSON, ex.: {"urgent":true}');
    return fields as Record<string, unknown>;
}
function readDriverMessagePath() {
    const path = process.env.AUTOCAB_DRIVER_MESSAGE_PATH || '/vehicle/v1/vehicles/message';
    if (!path.startsWith('/'))
        throw new Error('AUTOCAB_DRIVER_MESSAGE_PATH deve começar com /');
    return path;
}
export function readConfiguration(): AppConfig {
    const reservationMessagesMode = process.env.RESERVATION_MESSAGES_MODE || 'live';
    if (!['off', 'dry', 'live'].includes(reservationMessagesMode))
        throw new Error('RESERVATION_MESSAGES_MODE deve ser off, dry ou live');
    // Na Vercel corrige de verdade por padrão; fora dela (servidor local) fica em demonstração.
    const mode = process.env.AUTOCAB_MODE || (process.env.VERCEL ? 'live' : 'demo');
    if (!['demo', 'dry', 'live'].includes(mode))
        throw new Error('AUTOCAB_MODE deve ser demo, dry ou live');
    const host = process.env.HOST || '127.0.0.1';
    const panelToken = process.env.PANEL_TOKEN || '';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !panelToken)
        throw new Error('Configure PANEL_TOKEN para acesso remoto');
    return { mode: mode as OperatingMode, baseUrl: process.env.AUTOCAB_BASE_URL || 'https://autocab-api.azure-api.net', databasePath: process.env.DATABASE_PATH || 'data/autocab.sqlite', host, port: readPositiveInteger(process.env.PORT, 3001), panelToken,
        intervalMs: Math.max(5000, readPositiveInteger(process.env.CYCLE_INTERVAL_MS, 60000)), autoStart: process.env.AUTO_START !== 'false',
        protectedZoneNames: (process.env.PROTECTED_ZONES || 'NAK,FORA DE AREA,FORA D AREA').split(',').map(name => name.trim()).filter(Boolean),
        // Nomes aceitos para a zona de fora de área, separados por vírgula (a Arcoverde usa "FORA D AREA").
        outsideZoneName: process.env.OUTSIDE_ZONE_NAME ?? 'FORA D AREA,FORA DE AREA',
        companiesPath: process.env.AUTOCAB_COMPANIES_PATH || '/booking/v1/companies',
        autocabTimeoutMs: readPositiveInteger(process.env.AUTOCAB_TIMEOUT_MS, 10000),
        reservationMessagesMode: reservationMessagesMode as DriverMessagesMode,
        driverMessagesMode: readDriverMessagesMode(), driverMessagePath: readDriverMessagePath(), driverMessageFields: readDriverMessageFields(), driverMessageRecipients: readDriverMessageRecipients(), driverMessagesTop: process.env.DRIVER_MESSAGES_TOP?.trim() ? readPositiveInteger(process.env.DRIVER_MESSAGES_TOP, 1) : null, connections: readConnections() };
}
