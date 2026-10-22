import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readConfiguration } from './config.ts';
import { AutocabClient } from './autocab.ts';
import { DemoAutocabClient } from './demo.ts';
import { AuditRepository } from './repository.ts';
import { CorrectionService } from './correction-service.ts';
import { CorrectionScheduler } from './scheduler.ts';
import { createApplication } from './http.ts';
if (process.env.DATABASE_URL) {
    const { startPostgresServer } = await import('./postgres-server.ts');
    await startPostgresServer();
}
else {
    const configuration = readConfiguration();
    const databasePath = resolve(configuration.databasePath);
    mkdirSync(dirname(databasePath), { recursive: true });
    const repository = new AuditRepository(databasePath);
    repository.recoverInterruptedCycles();
    const connections = configuration.connections.map(connection => {
        const subscriptionKey = process.env[connection.subscriptionKeyEnvironmentVariable];
        const gateway = configuration.mode === 'demo' ? new DemoAutocabClient() : subscriptionKey ? new AutocabClient(configuration.baseUrl, subscriptionKey, fetch, configuration.autocabTimeoutMs, { companiesPath: configuration.companiesPath, driverMessagePath: configuration.driverMessagePath, driverMessageFields: configuration.driverMessageFields }) : null;
        return { id: connection.id, name: connection.name, companyId: connection.companyId, companyName: connection.companyName, driverMessages: connection.driverMessages, gateway };
    });
    const correctionService = new CorrectionService(repository, configuration, configuration.mode, configuration.driverMessagesMode, configuration.driverMessageRecipients, configuration.driverMessagesTop, configuration.reservationMessagesMode);
    const scheduler = new CorrectionScheduler(correctionService, connections, configuration.intervalMs);
    const application = createApplication(configuration, repository, scheduler, connections);
    const server = application.listen(configuration.port, configuration.host, () => {
        console.log(`Painel iniciado: modo ${configuration.mode}, porta ${configuration.port}`);
        if (configuration.autoStart)
            scheduler.start();
    });
    async function shutdown() { server.close(); await scheduler.stop(); repository.close(); }
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
}
