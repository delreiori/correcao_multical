import { readFileSync } from 'node:fs';
import type { OperatingMode } from '../shared/types.ts';
export interface ConnectionConfig {
    id: string;
    name: string;
    subscriptionKeyEnvironmentVariable: string;
    companyId?: number;
    companyName?: string;
    driverMessages?: boolean;
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
    driverMessagesMode: DriverMessagesMode;
    driverMessagePath: string;
    // Callsigns ou IDs que recebem os avisos; null = todos os motoristas livres da zona.
    driverMessageRecipients: string[] | null;
    connections: ConnectionConfig[];
}
// Empresas da Multicall corrigidas por padrão. Todas usam a mesma Subscription Key; o rastreio
// de cada uma fica separado pelo companyId, informado na variável ou resolvido pelo nome no GET de empresas.
export const MULTICALL_COMPANIES = [
    // Arcoverde avisa por mensagem os motoristas livres de cada zona quando a fila muda.
    { id: 'arcoverde', name: 'Arcoverde', companyIdEnvironmentVariable: 'AUTOCAB_COMPANY_ID_ARCOVERDE', driverMessages: true },
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
        return MULTICALL_COMPANIES.map(company => ({ id: company.id, name: company.name, subscriptionKeyEnvironmentVariable: 'AUTOCAB_SUBSCRIPTION_KEY', companyId: readOptionalCompanyId(company.companyIdEnvironmentVariable), companyName: company.name, driverMessages: company.driverMessages }));
    const connectionList: unknown = JSON.parse(readFileSync(process.env.AUTOCAB_CONNECTIONS_FILE, 'utf8'));
    if (!Array.isArray(connectionList) || connectionList.length === 0)
        throw new Error('Lista de conexões vazia ou inválida');
    const identifiers = new Set<string>();
    return connectionList.map((entry: unknown) => {
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
        identifiers.add(connection.id);
        return connection as unknown as ConnectionConfig;
    });
}
function readDriverMessagesMode(): DriverMessagesMode {
    const mode = process.env.DRIVER_MESSAGES_MODE || 'dry';
    if (!['off', 'dry', 'live'].includes(mode))
        throw new Error('DRIVER_MESSAGES_MODE deve ser off, dry ou live');
    return mode as DriverMessagesMode;
}
// Em teste os avisos vão só para o motorista 5013 (Luciano). DRIVER_MESSAGES_ONLY=* libera para todos.
function readDriverMessageRecipients(): string[] | null {
    const value = (process.env.DRIVER_MESSAGES_ONLY ?? '5013').trim();
    if (value === '*')
        return null;
    return value.split(',').map(recipient => recipient.trim()).filter(Boolean);
}
function readDriverMessagePath() {
    const path = process.env.AUTOCAB_DRIVER_MESSAGE_PATH || '/vehicle/v1/vehicles/message';
    if (!path.startsWith('/'))
        throw new Error('AUTOCAB_DRIVER_MESSAGE_PATH deve começar com /');
    return path;
}
export function readConfiguration(): AppConfig {
    const mode = process.env.AUTOCAB_MODE || (process.env.VERCEL ? 'dry' : 'demo');
    if (!['demo', 'dry', 'live'].includes(mode))
        throw new Error('AUTOCAB_MODE deve ser demo, dry ou live');
    const host = process.env.HOST || '127.0.0.1';
    const panelToken = process.env.PANEL_TOKEN || '';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !panelToken)
        throw new Error('Configure PANEL_TOKEN para acesso remoto');
    return { mode: mode as OperatingMode, baseUrl: process.env.AUTOCAB_BASE_URL || 'https://autocab-api.azure-api.net', databasePath: process.env.DATABASE_PATH || 'data/autocab.sqlite', host, port: readPositiveInteger(process.env.PORT, 3001), panelToken,
        intervalMs: Math.max(5000, readPositiveInteger(process.env.CYCLE_INTERVAL_MS, 60000)), autoStart: process.env.AUTO_START !== 'false',
        protectedZoneNames: (process.env.PROTECTED_ZONES || 'NAK,FORA DE AREA').split(',').map(name => name.trim()).filter(Boolean),
        outsideZoneName: process.env.OUTSIDE_ZONE_NAME ?? 'FORA DE AREA',
        companiesPath: process.env.AUTOCAB_COMPANIES_PATH || '/booking/v1/companies',
        driverMessagesMode: readDriverMessagesMode(), driverMessagePath: readDriverMessagePath(), driverMessageRecipients: readDriverMessageRecipients(), connections: readConnections() };
}
