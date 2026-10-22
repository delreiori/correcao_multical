import { randomUUID } from 'node:crypto';
import { CYCLE_TIME_BUDGET_MS } from './execution-limits.ts';
import { Pool } from 'pg';
import tls from 'node:tls';
import { supabaseRootCertificate } from './supabase-ca.ts';
import { readConfiguration } from './config.ts';
import { AutocabClient } from './autocab.ts';
import { DemoAutocabClient } from './demo.ts';
import { PostgresAuditRepository } from './postgres-repository.ts';
import { CorrectionService } from './correction-service.ts';
import type { CorrectionConnection } from './correction-service.ts';
export class CycleAlreadyRunningError extends Error {
}
export interface CycleRuntime {
    running: boolean;
    runOnce(): Promise<void>;
}
export class NeonCycleRunner implements CycleRuntime {
    private repository: PostgresAuditRepository;
    private service: CorrectionService;
    private connections: CorrectionConnection[];
    running = false;
    // Indica se a última execução terminou todas as empresas sem lote parcial nem falha.
    lastRunCompleted = false;
    private lastPruneAt = 0;
    constructor(repository: PostgresAuditRepository, service: CorrectionService, connections: CorrectionConnection[]) { this.repository = repository; this.service = service; this.connections = connections; }
    async runOnce() {
        if (this.running)
            throw new CycleAlreadyRunningError('Ciclo já em andamento');
        this.running = true;
        const owner = randomUUID();
        let acquired = false;
        this.lastRunCompleted = false;
        try {
            acquired = await this.repository.acquireCycleLease(owner);
            if (!acquired)
                throw new CycleAlreadyRunningError('Outra instância está executando um ciclo');
            await this.repository.recoverInterruptedCycles();
            // Limpa o histórico antigo no máximo uma vez por hora, para o banco não encher.
            if (Date.now() - this.lastPruneAt > 3_600_000) {
                this.lastPruneAt = Date.now();
                await this.repository.pruneHistory();
            }
            const deadline = Date.now() + CYCLE_TIME_BUDGET_MS;
            const snapshotCache = new Map();
            let completedConnections = 0;
            const nextConnectionIndex = await this.repository.getVehicleCursor(':connection-cursor');
            const startIndex = Math.max(0, nextConnectionIndex) % Math.max(1, this.connections.length);
            for (let offset = 0; offset < this.connections.length; offset++) {
                const connectionIndex = (startIndex + offset) % this.connections.length;
                const connection = this.connections[connectionIndex];
                if (Date.now() > deadline - 15000)
                    break;
                // Divide o tempo restante entre as empresas que faltam, para todas rodarem a cada ciclo.
                const remainingConnections = this.connections.length - offset;
                const connectionDeadline = Date.now() + (deadline - Date.now()) / remainingConnections;
                if (await this.service.runConnection(connection, { deadline: connectionDeadline, snapshotCache }) === 'completed')
                    completedConnections++;
                await this.repository.saveVehicleCursor(':connection-cursor', (connectionIndex + 1) % this.connections.length);
            }
            this.lastRunCompleted = completedConnections === this.connections.length;
        }
        finally {
            try {
                if (acquired)
                    await this.repository.releaseCycleLease(owner);
            }
            finally {
                this.running = false;
            }
        }
    }
}
// Aceita a connection string como costuma ser colada: com espaços, aspas, "DATABASE_URL=" na frente,
// colchetes do modelo do Supabase em volta da senha ou senha com caracteres especiais sem codificar.
// Nunca inclui o valor na mensagem de erro, porque ele contém a senha.
export function parseDatabaseUrl(rawValue: string): URL {
    let value = rawValue.trim().replace(/^DATABASE_URL\s*=\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    const match = /^(postgres(?:ql)?):\/\/([^:@/]*)(?::(.*))?@([^@/?#]+)(\/[^?#]*)?(\?[^#]*)?$/.exec(value);
    if (!match)
        throw new Error('DATABASE_URL inválida: use o formato postgresql://usuario:senha@host:porta/postgres');
    const [, protocol, user, rawPassword = '', host, path = '/postgres', query = ''] = match;
    if (/YOUR-PASSWORD/i.test(rawPassword))
        throw new Error('DATABASE_URL ainda tem [YOUR-PASSWORD]; troque pela senha do banco');
    let password = rawPassword.startsWith('[') && rawPassword.endsWith(']') ? rawPassword.slice(1, -1) : rawPassword;
    try {
        password = decodeURIComponent(password);
    }
    catch {
        // "%" solto na senha: usa o texto como está.
    }
    value = `${protocol}://${encodeURIComponent(decodeURIComponent(user))}:${encodeURIComponent(password)}@${host}${path}${query}`;
    try {
        return new URL(value);
    }
    catch {
        throw new Error('DATABASE_URL inválida: confira host e porta (ex.: aws-0-<região>.pooler.supabase.com:5432)');
    }
}
function createDatabasePool(databaseUrl: string) {
    const parsedUrl = parseDatabaseUrl(databaseUrl);
    // Keep TLS certificate verification active, including when the provider gives sslmode=require.
    for (const parameter of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'])
        parsedUrl.searchParams.delete(parameter);
    // Sem statement_timeout na conexão: poolers (Supabase/PgBouncer) recusam parâmetros de início
    // desconhecidos. query_timeout limita cada consulta do lado do cliente.
    return new Pool({ connectionString: parsedUrl.toString(), ssl: { rejectUnauthorized: true, ca: databaseCertificateAuthorities(parsedUrl.hostname) }, max: 3, connectionTimeoutMillis: 8000, query_timeout: 8000, idleTimeoutMillis: 10000 });
}
// CAs aceitas no TLS do banco: as públicas do Node, a raiz do Supabase quando o host é do Supabase e,
// opcionalmente, DATABASE_SSL_CA (PEM; aceita "\n" escrito no lugar das quebras). A verificação nunca é desligada.
export function databaseCertificateAuthorities(hostname: string) {
    const authorities = [...tls.rootCertificates];
    if (/(^|\.)supabase\.(com|co)$/.test(hostname))
        authorities.push(supabaseRootCertificate);
    const extraAuthority = process.env.DATABASE_SSL_CA?.replace(/\\n/g, '\n').trim();
    if (extraAuthority)
        authorities.push(extraAuthority);
    return authorities;
}
// Explica a falha de conexão pelo código do erro, sem expor a mensagem (pode conter dados da conexão).
export function describeDatabaseError(error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))
        return `certificado TLS do banco não reconhecido (${code}); confira o host do banco ou configure DATABASE_SSL_CA com o certificado PEM`;
    if (code === '28P01' || code === '28000')
        return `usuário ou senha do banco recusados (${code}); copie de novo a connection string`;
    if (['ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(code))
        return `endereço do banco inacessível (${code}); no Supabase use a connection string do pooler (Session ou Transaction pooler), não a direta`;
    if (['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET'].includes(code))
        return `banco não respondeu (${code}); confira se o projeto está ativo`;
    if (code === '53300' || code === 'XX000')
        return `banco recusou a conexão (${code}); confira limites e status do projeto`;
    return code ? `falha ao conectar (${code})` : 'falha ao conectar';
}
async function initializeDatabase(pool: Pool) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(89120744)');
        const { postgresSchema } = await import('./postgres-schema.ts');
        await client.query(postgresSchema);
        await client.query('COMMIT');
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        client.release();
    }
}
export async function createNeonRuntime() {
    if (!process.env.DATABASE_URL)
        throw new Error('Configure DATABASE_URL na Vercel');
    const configuration = readConfiguration();
    if (!configuration.panelToken)
        throw new Error('Configure PANEL_TOKEN para proteger o painel');
    const pool = createDatabasePool(process.env.DATABASE_URL);
    // Do not log database errors: connection details can include credentials.
    pool.on('error', () => console.error('Conexão com PostgreSQL interrompida'));
    const repository = new PostgresAuditRepository({ query: async (sql, parameters) => { const result = await pool.query(sql, parameters); return { rows: result.rows }; } });
    try {
        await initializeDatabase(pool);
    }
    catch (error) {
        await pool.end();
        throw new Error(`Não foi possível preparar o banco PostgreSQL: ${describeDatabaseError(error)}`);
    }
    const connections: CorrectionConnection[] = configuration.connections.map(connection => {
        const key = process.env[connection.subscriptionKeyEnvironmentVariable];
        const gateway = configuration.mode === 'demo' ? new DemoAutocabClient() : key ? new AutocabClient(configuration.baseUrl, key, fetch, configuration.autocabTimeoutMs, { companiesPath: configuration.companiesPath, driverMessagePath: configuration.driverMessagePath, driverMessageFields: configuration.driverMessageFields }) : null;
        return { id: connection.id, name: connection.name, companyId: connection.companyId, companyName: connection.companyName, driverMessages: connection.driverMessages, gateway };
    });
    const service = new CorrectionService(repository, configuration, configuration.mode, configuration.driverMessagesMode, configuration.driverMessageRecipients, configuration.driverMessagesTop, configuration.reservationMessagesMode);
    const runner = new NeonCycleRunner(repository, service, connections);
    return { configuration, repository, connections, runner, close: () => pool.end() };
}
