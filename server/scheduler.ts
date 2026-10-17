import { CorrectionService } from './correction-service.ts';
import type { CorrectionConnection } from './correction-service.ts';
export class CorrectionScheduler {
    private service: CorrectionService;
    private connections: CorrectionConnection[];
    private intervalMs: number;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private stopped = true;
    private activeCycle: Promise<void> | null = null;
    constructor(service: CorrectionService, connections: CorrectionConnection[], intervalMs: number) { this.service = service; this.connections = connections; this.intervalMs = intervalMs; }
    get running() { return this.activeCycle !== null; }
    private async executeConnections() { for (const connection of this.connections)
        await this.service.runConnection(connection); }
    async runOnce() {
        if (this.activeCycle)
            throw new Error('Já existe um ciclo em andamento');
        this.activeCycle = this.executeConnections();
        try {
            await this.activeCycle;
        }
        finally {
            this.activeCycle = null;
        }
    }
    private async tick() {
        try {
            if (!this.running)
                await this.runOnce();
        }
        catch {
            console.error('Falha no ciclo; consulte o histórico de ciclos.');
        }
        finally {
            if (!this.stopped)
                this.timer = setTimeout(() => void this.tick(), this.intervalMs);
        }
    }
    start() { if (!this.stopped)
        return; this.stopped = false; void this.tick(); }
    async stop() { this.stopped = true; if (this.timer)
        clearTimeout(this.timer); await this.activeCycle; }
}
