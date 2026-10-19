import { randomUUID } from 'node:crypto';
import { CYCLE_TIME_BUDGET_MS } from './execution-limits.ts';
import { Pool } from 'pg';
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
function createDatabasePool(databaseUrl: string) {
    const parsedUrl = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol))
        throw new Error('DATABASE_URL deve ser PostgreSQL');
    // Keep TLS certificate verification active, including when Neon gives sslmode=require.
    for (const parameter of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'])
        parsedUrl.searchParams.delete(parameter);
    return new Pool({ connectionString: parsedUrl.toString(), ssl: { rejectUnauthorized: true }, max: 3, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000, idleTimeoutMillis: 10000 });
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
    catch {
        await pool.end();
        throw new Error('Não foi possível preparar o Neon; confira DATABASE_URL e acesso ao banco');
    }
    const connections: CorrectionConnection[] = configuration.connections.map(connection => {
        const key = process.env[connection.subscriptionKeyEnvironmentVariable];
        const gateway = configuration.mode === 'demo' ? new DemoAutocabClient() : key ? new AutocabClient(configuration.baseUrl, key, fetch, 4000, configuration.companiesPath) : null;
        return { id: connection.id, name: connection.name, companyId: connection.companyId, companyName: connection.companyName, gateway };
    });
    const service = new CorrectionService(repository, configuration, configuration.mode);
    const runner = new NeonCycleRunner(repository, service, connections);
    return { configuration, repository, connections, runner, close: () => pool.end() };
}
