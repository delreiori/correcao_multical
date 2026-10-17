import { createNeonRuntime } from './neon-runtime.ts';
import { createApplication } from './http.ts';
export async function startPostgresServer() {
    const runtime = await createNeonRuntime();
    const { configuration, repository, runner, connections } = runtime;
    const application = createApplication(configuration, repository, runner, connections);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeCycle: Promise<void> | null = null;
    async function scheduleNextCycle() {
        activeCycle = runner.runOnce();
        try {
            await activeCycle;
        }
        catch {
            console.error('Ciclo PostgreSQL não concluído; consulte o histórico.');
        }
        finally {
            activeCycle = null;
            if (!stopped)
                timer = setTimeout(() => void scheduleNextCycle(), configuration.intervalMs);
        }
    }
    const server = application.listen(configuration.port, configuration.host, () => {
        console.log(`Painel PostgreSQL iniciado: modo ${configuration.mode}, porta ${configuration.port}`);
        if (configuration.autoStart)
            void scheduleNextCycle();
    });
    async function shutdown() { stopped = true; if (timer)
        clearTimeout(timer); server.close(); await activeCycle; await runtime.close(); }
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
}
