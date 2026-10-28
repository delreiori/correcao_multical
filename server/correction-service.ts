import { AutocabRequestError } from './autocab.ts';
import type { AutocabGateway } from './autocab.ts';
import type { AuditStore } from './audit-store.ts';
import { chooseTargetZone, findOutsideZone, calculateQueueTail, describeChange, isBusy, normalizeZoneName } from './rules.ts';
import type { ZoneRules } from './rules.ts';
import type { FleetSnapshot, OperatingMode, PlannedChange, Vehicle, VehicleStatus, Zone } from '../shared/types.ts';
import type { DriverMessagesMode } from './config.ts';
import { notifyQueueChanges } from './driver-messages.ts';
import { notifyReservations } from './reservation-messages.ts';
export interface CorrectionConnection {
    id: string;
    name: string;
    companyId?: number;
    companyName?: string;
    driverMessages?: boolean;
    gateway: AutocabGateway | null;
}
// Resolve o companyId pelo nome da empresa no GET de empresas. Nunca segue sem empresa definida:
// isso corrigiria veículos de todas as empresas da chave.
export async function resolveCompanyId(connection: CorrectionConnection, gateway: AutocabGateway): Promise<number | undefined> {
    if (connection.companyId !== undefined || connection.companyName === undefined)
        return connection.companyId;
    const companies = await gateway.listCompanies();
    const wantedName = normalizeZoneName(connection.companyName);
    const namedCompanies = companies.filter(company => company.name !== null);
    // Nome exato primeiro; senão aceita um único nome que contenha o configurado (ex.: "Arcoverde Táxi").
    let matchingCompanies = namedCompanies.filter(company => normalizeZoneName(company.name!) === wantedName);
    if (matchingCompanies.length === 0)
        matchingCompanies = namedCompanies.filter(company => normalizeZoneName(company.name!).includes(wantedName));
    if (matchingCompanies.length !== 1) {
        const available = companies.map(company => `${company.id}${company.name ? ' ' + company.name : ''}`).join(', ') || 'nenhuma';
        throw new Error(`Empresa "${connection.companyName}" ${matchingCompanies.length ? 'ambígua' : 'não encontrada'} no GET de empresas; configure o companyId. Disponíveis: ${available}`);
    }
    return matchingCompanies[0].id;
}
// Consultas simultâneas de zona por GPS; mantém a carga na Autocab limitada.
const GPS_LOOKUP_CONCURRENCY = 16;
// Zona por GPS reaproveitada enquanto o carro não se mexe (~11 m, 4 casas decimais) por até 2 minutos.
const ZONE_LOOKUP_TTL_MS = 120_000;
// Zonas e veículos quase não mudam: a passada rápida reaproveita a última leitura por até 1 minuto.
const FLEET_CACHE_TTL_MS = 60_000;
function safeErrorMessage(error: unknown) { return error instanceof Error ? error.message : 'Falha não identificada na correção'; }
export class CorrectionService {
    private repository: AuditStore;
    private rules: ZoneRules;
    private mode: OperatingMode;
    private deadline = Infinity;
    private deferred = false;
    private inspectedCount = 0;
    private notes: string[] = [];
    private resolvedCompanyIds = new Map<string, number>();
    private driverMessagesMode: DriverMessagesMode;
    private reservationMessagesMode: DriverMessagesMode;
    private driverMessageRecipients: string[] | null;
    private driverMessagesTop: number | null;
    constructor(repository: AuditStore, rules: ZoneRules, mode: OperatingMode, driverMessagesMode: DriverMessagesMode = 'off', driverMessageRecipients: string[] | null = null, driverMessagesTop: number | null = null, reservationMessagesMode: DriverMessagesMode = 'off') { this.repository = repository; this.rules = rules; this.mode = mode; this.driverMessagesMode = driverMessagesMode; this.driverMessageRecipients = driverMessageRecipients; this.driverMessagesTop = driverMessagesTop; this.reservationMessagesMode = reservationMessagesMode; }
    private zoneLookups = new Map<string, { zoneId: number | null; at: number }>();
    // Só consulta a Autocab quando o carro se moveu desde a última consulta; parado no ponto, reaproveita.
    private async lookupZone(gateway: AutocabGateway, vehicleId: number, latitude: number, longitude: number, companyId?: number) {
        const key = `${companyId ?? ''}:${vehicleId}:${latitude.toFixed(4)}:${longitude.toFixed(4)}`;
        const cached = this.zoneLookups.get(key);
        if (cached && Date.now() - cached.at < ZONE_LOOKUP_TTL_MS)
            return cached.zoneId;
        const zoneId = await gateway.findZoneByCoordinates(latitude, longitude, companyId);
        if (this.zoneLookups.size > 20_000)
            this.zoneLookups.clear();
        this.zoneLookups.set(key, { zoneId, at: Date.now() });
        return zoneId;
    }
    // Passada rápida: zonas e veículos da última leitura (se recentes) e só status e GPS novos.
    private async loadFastSnapshot(connectionId: string, gateway: AutocabGateway): Promise<FleetSnapshot | null> {
        const fleet = this.lastFleets.get(connectionId);
        if (!fleet || Date.now() - fleet.at > FLEET_CACHE_TTL_MS)
            return null;
        const [statuses, gpsPositions] = await Promise.all([gateway.listVehicleStatuses(), gateway.listGpsPositions()]);
        if (new Set(statuses.map(status => status.vehicleId)).size !== statuses.length)
            throw new Error('IDs de veículos duplicados nos statuses');
        return { zones: fleet.zones, vehicles: fleet.vehicles, statuses, gpsPositions };
    }
    private async loadSnapshot(gateway: AutocabGateway): Promise<FleetSnapshot> {
        const [zones, vehicles, statuses, gpsPositions] = await Promise.all([gateway.listZones(), gateway.listVehicles(), gateway.listVehicleStatuses(), gateway.listGpsPositions()]);
        if (new Set(zones.map(zone => zone.id)).size !== zones.length)
            throw new Error('IDs de zonas duplicados na mesma conexão');
        if (new Set(statuses.map(status => status.vehicleId)).size !== statuses.length)
            throw new Error('IDs de veículos duplicados nos statuses');
        return { zones, vehicles, statuses, gpsPositions };
    }
    private async reconcileUnresolvedChanges(connectionId: string, statuses: VehicleStatus[]) {
        for (const change of await this.repository.listUnresolvedChanges(connectionId)) {
            const currentStatus = statuses.find(status => status.vehicleId === change.vehicleId);
            if (currentStatus?.zoneId === change.targetZoneId)
                await this.repository.finishChange(change.id, 'confirmed', change.httpStatus, 'Zona de destino confirmada em consulta posterior; posição na fila pode ter avançado.');
        }
    }
    private async planChanges(connection: CorrectionConnection, snapshot: FleetSnapshot, gateway: AutocabGateway): Promise<PlannedChange[]> {
        const blockedChanges = await this.repository.listUnresolvedChanges(connection.id);
        const blockedVehicles = new Set(blockedChanges.map(change => change.vehicleId));
        const reservedQueuePositions = new Map<number, number>();
        for (const change of blockedChanges)
            reservedQueuePositions.set(change.targetZoneId, Math.max(reservedQueuePositions.get(change.targetZoneId) ?? 0, change.position));
        const plannedChanges: PlannedChange[] = [];
        const cursor = await this.repository.getVehicleCursor?.(connection.id) ?? -1;
        const orderedStatuses = [...snapshot.statuses].sort((left, right) => left.vehicleId - right.vehicleId);
        const statusesAfterCursor = orderedStatuses.filter(status => status.vehicleId > cursor);
        const statusesBeforeCursor = orderedStatuses.filter(status => status.vehicleId <= cursor);
        const vehiclesById = new Map(snapshot.vehicles.map(vehicle => [vehicle.id, vehicle]));
        let statusesToInspect = [...statusesAfterCursor, ...statusesBeforeCursor];
        if (connection.companyId !== undefined) {
            // Percorre somente a frota desta empresa; a chave Multicall devolve os veículos de todas.
            const withoutCompany = statusesToInspect.filter(status => vehiclesById.get(status.vehicleId)?.companyId == null).length;
            statusesToInspect = statusesToInspect.filter(status => vehiclesById.get(status.vehicleId)?.companyId === connection.companyId);
            this.notes.push(`companyId ${connection.companyId}: ${statusesToInspect.length} veículos da empresa de ${snapshot.statuses.length} retornados`);
            if (withoutCompany > 0)
                this.notes.push(`${withoutCompany} veículos sem companyId ignorados`);
        }
        const companyId = connection.companyId;
        const outsideZoneMissing = companyId !== undefined && this.rules.outsideZoneName !== '' && findOutsideZone(snapshot.zones, this.rules) === null;
        if (outsideZoneMissing)
            this.notes.push(`zona ${this.rules.outsideZoneName} não existe nesta empresa; ocupados não são movidos`);
        const zoneCompanyIds = new Set(snapshot.zones.map(zone => zone.companyId).filter(zoneCompanyId => zoneCompanyId !== null));
        const gpsByVehicle = new Map(snapshot.gpsPositions.map(position => [position.vehicleId, position]));
        for (let start = 0; start < statusesToInspect.length; start += GPS_LOOKUP_CONCURRENCY) {
            if (Date.now() > this.deadline - 15000) {
                this.deferred = true;
                break;
            }
            const chunk = statusesToInspect.slice(start, start + GPS_LOOKUP_CONCURRENCY);
            // Consultas de zona por GPS do lote em paralelo; a decisão segue a ordem dos veículos.
            const candidates = await Promise.all(chunk.map(async status => {
                if (status.hasPenalty || status.zoneId === null || blockedVehicles.has(status.vehicleId))
                    return null;
                const vehicle = vehiclesById.get(status.vehicleId);
                if (!vehicle)
                    return null;
                const vehicleCompanyId = companyId ?? vehicle.companyId ?? undefined;
                if (vehicleCompanyId === undefined && zoneCompanyIds.size > 1)
                    throw new Error('Várias empresas nas zonas, mas veículo sem companyId; configure uma conexão por empresa');
                const companyZones = snapshot.zones.filter(zone => zone.companyId === null || vehicleCompanyId === undefined || zone.companyId === vehicleCompanyId);
                const currentZone = companyZones.find(zone => zone.id === status.zoneId);
                if (!currentZone)
                    return null;
                const gpsPosition = gpsByVehicle.get(status.vehicleId);
                const gpsZoneId = !isBusy(status) && gpsPosition ? await this.lookupZone(gateway, status.vehicleId, gpsPosition.latitude, gpsPosition.longitude, vehicleCompanyId) : null;
                return { status, vehicle, companyZones, currentZone, gpsPosition, gpsZoneId };
            }));
            for (const candidate of candidates) {
                if (!candidate)
                    continue;
                const { status, vehicle, companyZones, currentZone, gpsPosition, gpsZoneId } = candidate;
                const gpsZone = companyZones.find(zone => zone.id === gpsZoneId) ?? null;
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
    private async verifySentChanges(gateway: AutocabGateway, sentChanges: { change: PlannedChange; changeId: string; httpStatus: number }[]): Promise<VehicleStatus[] | null> {
        if (sentChanges.length === 0)
            return null;
        let statusList: VehicleStatus[];
        try {
            statusList = await gateway.listVehicleStatuses();
        }
        catch {
            for (const { changeId, httpStatus } of sentChanges)
                await this.repository.finishChange(changeId, 'unconfirmed', httpStatus, 'POST aceito; consulta de confirmação falhou. Não repetir automaticamente.');
            return null;
        }
        const latestStatuses = new Map(statusList.map(status => [status.vehicleId, status]));
        for (const { change, changeId, httpStatus } of sentChanges) {
            const isConfirmed = latestStatuses.get(change.vehicleId)?.zoneId === change.targetZoneId;
            await this.repository.finishChange(changeId, isConfirmed ? 'confirmed' : 'unconfirmed', httpStatus, isConfirmed ? 'Zona confirmada após envio; posição enviada registrada no histórico.' : 'POST aceito; zona ainda não confirmada. Veículo bloqueado para nova tentativa automática.');
        }
        return statusList;
    }
    private async recordSendFailure(changeId: string, error: unknown) {
        const httpStatus = error instanceof AutocabRequestError ? error.httpStatus : null;
        const isDefiniteRejection = httpStatus !== null && httpStatus >= 400 && httpStatus < 500;
        await this.repository.finishChange(changeId, isDefiniteRejection ? 'failed' : 'unknown', httpStatus, isDefiniteRejection ? `Autocab rejeitou a alteração: HTTP ${httpStatus}.` : 'Resultado incerto. Veículo bloqueado até uma consulta confirmar o destino.');
    }
    private async executeChange(connection: CorrectionConnection, cycleId: string, change: PlannedChange, gateway: AutocabGateway, latestStatuses: VehicleStatus[], reservedPositions: Map<number, number>, sentChanges: { change: PlannedChange; changeId: string; httpStatus: number }[]) {
        if (this.mode === 'dry') {
            const changeId = await this.repository.createChange(connection.id, cycleId, this.mode, change, 'planned');
            await this.repository.finishChange(changeId, 'planned', null, 'Simulação com dados reais; nenhum POST enviado.');
            return;
        }
        const latestStatus = latestStatuses.find(status => status.vehicleId === change.vehicleId);
        const busyStateChanged = latestStatus ? isBusy(latestStatus) !== (change.reason === 'busy-outside') : true;
        if (!latestStatus || latestStatus.hasPenalty || latestStatus.zoneId !== change.previousZoneId || busyStateChanged) {
            const changeId = await this.repository.createChange(connection.id, cycleId, this.mode, change, 'skipped');
            await this.repository.finishChange(changeId, 'skipped', null, 'Estado do veículo mudou entre planejamento e envio.');
            return;
        }
        change.position = Math.max(change.position, calculateQueueTail(latestStatuses, change.targetZoneId) + 1, (reservedPositions.get(change.targetZoneId) ?? 0) + 1);
        reservedPositions.set(change.targetZoneId, change.position);
        const changeId = await this.repository.createChange(connection.id, cycleId, this.mode, change, 'pending');
        try {
            const httpStatus = await gateway.applyVehiclePlot(change.vehicleId, change.targetZoneId, change.position);
            sentChanges.push({ change, changeId, httpStatus });
        }
        catch (error) {
            await this.recordSendFailure(changeId, error);
        }
    }
    // Última leitura de zonas/veículos por conexão, reaproveitada pela passada rápida entre passadas.
    private lastFleets = new Map<string, { zones: Zone[]; vehicles: Vehicle[]; companyId?: number; at: number }>();
    private messagesSent = 0;
    private async notifyDriverQueues(connection: CorrectionConnection, cycleId: string, snapshot: { zones: Zone[]; vehicles: Vehicle[] }, statuses: VehicleStatus[]) {
        if (!connection.driverMessages || connection.companyId === undefined || !connection.gateway)
            return;
        // Falha no aviso não desfaz a correção; fica registrada no detalhe do ciclo.
        try {
            const result = await notifyQueueChanges({ store: this.repository, gateway: connection.gateway, connectionId: connection.id, companyName: connection.companyName ?? connection.name, cycleId, mode: this.mode, messagesMode: this.driverMessagesMode, zones: snapshot.zones, statuses, vehicles: snapshot.vehicles.filter(vehicle => vehicle.companyId === connection.companyId), rules: this.rules, recipients: this.driverMessageRecipients, topDrivers: this.driverMessagesTop });
            this.messagesSent += result.messages;
            if (result.messages > 0)
                this.notes.push(`avisos de fila: ${result.zonesChanged} zonas, ${result.messages} mensagens${result.failed ? `, ${result.failed} falharam` : ''}`);
        }
        catch (error) {
            this.notes.push(`avisos de fila não enviados: ${safeErrorMessage(error)}`);
        }
    }
    async runConnection(connection: CorrectionConnection, options: {
        deadline?: number;
        snapshotCache?: Map<AutocabGateway, Promise<FleetSnapshot>>;
        // Passada rápida da Arcoverde entre as completas: reaproveita zonas/veículos e não registra
        // ciclo quando nada mudou, para o histórico não encher.
        fast?: boolean;
    } = {}): Promise<string> {
        this.deadline = options.deadline ?? Infinity;
        this.deferred = false;
        this.inspectedCount = 0;
        this.notes = [];
        this.messagesSent = 0;
        const cycleId = await this.repository.startCycle(connection.id, this.mode);
        let inspected = 0, planned = 0;
        try {
            if (!connection.gateway)
                throw new Error('Subscription Key ausente nesta conexão');
            const gateway = connection.gateway;
            if (connection.companyId === undefined && connection.companyName !== undefined) {
                const companyId = this.resolvedCompanyIds.get(connection.id) ?? await resolveCompanyId(connection, gateway);
                if (companyId !== undefined)
                    this.resolvedCompanyIds.set(connection.id, companyId);
                connection = { ...connection, companyId };
            }
            if (connection.id === 'sao-conrado' && normalizeZoneName(connection.companyName ?? connection.name) === 'SAO CONRADO' && connection.companyId !== undefined && this.reservationMessagesMode !== 'off' && this.mode !== 'demo') {
                try {
                    const result = await notifyReservations({ store: this.repository, gateway, connectionId: connection.id,
                        companyId: connection.companyId, cycleId, vehicles: await gateway.listVehicles(), mode: this.mode,
                        messagesMode: this.reservationMessagesMode, deadline: this.deadline - 15000 });
                    this.notes.push(`${result.detail ? result.detail + '; ' : ''}avisos de reservas à São Conrado: ${result.sent} enviados, ${result.simulated} simulados, ${result.failed} falhas/incertos`);
                } catch (error) {
                    this.notes.push(`avisos de reservas não concluídos: ${safeErrorMessage(error)}`);
                }
            }
            let snapshot = options.fast ? await this.loadFastSnapshot(connection.id, gateway) : null;
            if (!snapshot) {
                // As empresas da mesma chave reaproveitam a leitura da frota feita no ciclo.
                let snapshotPromise = options.snapshotCache?.get(gateway);
                if (!snapshotPromise) {
                    snapshotPromise = this.loadSnapshot(gateway);
                    options.snapshotCache?.set(gateway, snapshotPromise);
                    snapshotPromise.catch(() => options.snapshotCache?.delete(gateway));
                }
                snapshot = await snapshotPromise;
                // Com várias empresas na mesma chave, cada conexão guarda e usa somente as zonas da sua empresa.
                if (connection.companyId !== undefined)
                    snapshot = { ...snapshot, zones: snapshot.zones.filter(zone => zone.companyId === null || zone.companyId === connection.companyId) };
                await this.repository.saveZones(connection.id, snapshot.zones);
                this.lastFleets.set(connection.id, { zones: snapshot.zones, vehicles: snapshot.vehicles, companyId: connection.companyId, at: Date.now() });
            }
            // Avisa as mudanças de fila já vistas na leitura, antes da correção por GPS (que demora).
            await this.notifyDriverQueues(connection, cycleId, snapshot, snapshot.statuses);
            if (this.mode === 'live')
                await this.reconcileUnresolvedChanges(connection.id, snapshot.statuses);
            const changes = await this.planChanges(connection, snapshot, gateway);
            planned = changes.length;
            inspected = this.inspectedCount;
            // Envio sequencial mantém a ordem dos veículos destinados à mesma fila. Os status são
            // relidos uma vez antes do lote para cancelar veículos que mudaram desde o planejamento.
            const reservedPositions = new Map<number, number>();
            const sentChanges: { change: PlannedChange; changeId: string; httpStatus: number }[] = [];
            const latestStatuses = this.mode !== 'dry' && changes.length > 0 ? await gateway.listVehicleStatuses() : [];
            let statusesAfterSend: VehicleStatus[] | null = null;
            try {
                for (const change of changes) {
                    if (Date.now() > this.deadline - 15000) {
                        this.deferred = true;
                        await this.repository.saveVehicleCursor?.(connection.id, change.vehicleId - 1);
                        break;
                    }
                    await this.executeChange(connection, cycleId, change, gateway, latestStatuses, reservedPositions, sentChanges);
                }
            }
            finally {
                statusesAfterSend = await this.verifySentChanges(gateway, sentChanges);
            }
            // Depois dos envios, avisa as filas alteradas pelas próprias correções.
            if (statusesAfterSend)
                await this.notifyDriverQueues(connection, cycleId, snapshot, statusesAfterSend);
            if (this.deferred)
                this.notes.push('Tempo do ciclo esgotado; veículos restantes serão retomados no próximo ciclo.');
            const outcome = this.deferred ? 'partial' : 'completed';
            if (options.fast && outcome === 'completed' && planned === 0 && this.messagesSent === 0 && this.repository.discardCycle) {
                await this.repository.discardCycle(cycleId);
                return outcome;
            }
            await this.repository.finishCycle(cycleId, outcome, inspected, planned, [options.fast ? 'passada rápida' : '', ...this.notes].filter(Boolean).join('. ') || null);
            return outcome;
        }
        catch (error) {
            // Mensagens próprias, sem credenciais; aparecem no log da Vercel para diagnosticar quedas.
            console.error(`Ciclo ${connection.id} falhou: ${safeErrorMessage(error)}`);
            await this.repository.finishCycle(cycleId, 'failed', this.inspectedCount, planned, [...this.notes, safeErrorMessage(error)].join('. '));
            return 'failed';
        }
    }
}
