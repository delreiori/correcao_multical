import type { Company, Zone, Vehicle, VehicleStatus, VehicleGpsPosition } from '../shared/types.ts';
export interface AutocabGateway {
    searchReservations?(companyId: number): Promise<Reservation[]>;
    listCompanies(): Promise<Company[]>;
    listZones(): Promise<Zone[]>;
    listVehicles(): Promise<Vehicle[]>;
    listVehicleStatuses(): Promise<VehicleStatus[]>;
    listGpsPositions(): Promise<VehicleGpsPosition[]>;
    findZoneByCoordinates(latitude: number, longitude: number, companyId?: number): Promise<number | null>;
    applyVehiclePlot(vehicleId: number, zoneId: number, position: number): Promise<number>;
    sendDriverMessage(vehicleId: number, message: string, urgent?: boolean): Promise<number>;
}
export interface Reservation {
    id: number;
    companyId: number;
    bookedAtTime: string;
    pickupDueTimeUtc: string;
}
export interface AutocabClientOptions {
    companiesPath?: string;
    driverMessagePath?: string;
    // Campos extras do corpo da mensagem; marcam o aviso como urgente.
    driverMessageFields?: Record<string, unknown>;
}
export class AutocabRequestError extends Error {
    httpStatus: number | null;
    constructor(message: string, httpStatus: number | null = null) { super(message); this.httpStatus = httpStatus; }
}
function requireObject(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new AutocabRequestError('Resposta Autocab contém registro inválido');
    return value as Record<string, unknown>;
}
function requireIdentifier(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new AutocabRequestError('Resposta Autocab contém ID inválido');
    return value;
}
function optionalIdentifier(value: unknown): number | null { return value == null ? null : requireIdentifier(value); }
function parseZone(value: unknown): Zone {
    const zone = requireObject(value);
    const name = typeof zone.name === 'string' && zone.name.trim() ? zone.name : zone.descriptor;
    if (typeof name !== 'string' || !name.trim())
        throw new AutocabRequestError('Zona sem nome ou descriptor');
    return { id: requireIdentifier(zone.id), name, companyId: optionalIdentifier(zone.companyId) };
}
function parseCompany(value: unknown): Company {
    const company = requireObject(value);
    const name = [company.name, company.companyName, company.descriptor].find(candidate => typeof candidate === 'string' && candidate.trim());
    return { id: requireIdentifier(company.id ?? company.companyId), name: typeof name === 'string' ? name : null };
}
function parseVehicle(value: unknown): Vehicle {
    const vehicle = requireObject(value);
    return { id: requireIdentifier(vehicle.id), callsign: String(vehicle.callsign ?? vehicle.id), companyId: optionalIdentifier(vehicle.companyId) };
}
function parseVehicleStatus(value: unknown): VehicleStatus {
    const status = requireObject(value);
    if (typeof status.vehicleStatusType !== 'string' || !status.vehicleStatusType.trim() || !Object.hasOwn(status, 'penalty'))
        throw new AutocabRequestError('Status sem vehicleStatusType ou penalty; confirme o contrato');
    return { vehicleId: requireIdentifier(status.id), zoneId: optionalIdentifier(status.zoneId), queuePosition: optionalIdentifier(status.queuePosition), status: status.vehicleStatusType, hasPenalty: status.penalty != null };
}
function parseGpsPosition(value: unknown): VehicleGpsPosition | null {
    const position = requireObject(value);
    const vehicleId = requireIdentifier(position.id ?? position.vehicleId);
    if (position.location == null)
        return null;
    const location = requireObject(position.location);
    if (typeof location.latitude !== 'number' || typeof location.longitude !== 'number')
        return null;
    if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude) || Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180)
        return null;
    if (location.latitude === 0 && location.longitude === 0)
        return null;
    return { vehicleId, latitude: location.latitude, longitude: location.longitude };
}
export class AutocabClient implements AutocabGateway {
    private baseUrl: URL;
    private subscriptionKey: string;
    private requestFetch: typeof fetch;
    private timeoutMs: number;
    private companiesPath: string;
    private driverMessagePath: string;
    private driverMessageFields: Record<string, unknown>;
    constructor(baseUrl: string, subscriptionKey: string, requestFetch: typeof fetch = fetch, timeoutMs = 15000, options: AutocabClientOptions = {}) {
        this.baseUrl = new URL(baseUrl);
        if (this.baseUrl.protocol !== 'https:' || this.baseUrl.username || this.baseUrl.password)
            throw new Error('Base Autocab deve usar HTTPS sem credenciais na URL');
        if (!subscriptionKey)
            throw new Error('Subscription Key não configurada');
        this.subscriptionKey = subscriptionKey;
        this.requestFetch = requestFetch;
        this.timeoutMs = timeoutMs;
        this.companiesPath = options.companiesPath ?? '/booking/v1/companies';
        this.driverMessagePath = options.driverMessagePath ?? '/vehicle/v1/vehicles/message';
        this.driverMessageFields = options.driverMessageFields ?? { urgent: true };
    }
    private async sendRequest(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<Response> {
        const headers: Record<string, string> = { 'Accept': 'application/json', 'Ocp-Apim-Subscription-Key': this.subscriptionKey };
        if (body !== undefined)
            headers['Content-Type'] = 'application/json';
        let response: Response;
        try {
            response = await this.requestFetch(new URL(path, this.baseUrl), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
        }
        catch {
            throw new AutocabRequestError('Falha de rede ou timeout na Autocab');
        }
        if (!response.ok)
            throw new AutocabRequestError(`Autocab respondeu HTTP ${response.status}`, response.status);
        return response;
    }
    private async readJson(path: string): Promise<unknown> {
        const response = await this.sendRequest(path);
        try {
            return await response.json();
        }
        catch {
            throw new AutocabRequestError('Resposta Autocab não é JSON válido');
        }
    }
    private async readArray(path: string): Promise<unknown[]> {
        const responseBody = await this.readJson(path);
        if (!Array.isArray(responseBody))
            throw new AutocabRequestError('Resposta Autocab não é uma lista; confirme o contrato');
        return responseBody;
    }
    // Lista todas as empresas visíveis à chave. Sem o endpoint de empresas (404), usa os companyId
    // presentes em zonas e veículos; nesse caso os nomes ficam ausentes e o ID deve ser configurado.
    async listCompanies(): Promise<Company[]> {
        try {
            return (await this.readArray(this.companiesPath)).map(parseCompany);
        }
        catch (error) {
            if (!(error instanceof AutocabRequestError) || error.httpStatus !== 404)
                throw error;
        }
        const [zones, vehicles] = await Promise.all([this.listZones(), this.listVehicles()]);
        const companyIds = new Set([...zones, ...vehicles].map(record => record.companyId).filter(companyId => companyId !== null));
        return [...companyIds].sort((left, right) => left - right).map(id => ({ id, name: null }));
    }
    async listZones() { return (await this.readArray('/booking/v1/zones')).map(parseZone); }
    // Booking OpenAPI: Search v2, a read-only search despite using POST.
    // No date window: includes reservations scheduled arbitrarily far ahead.
    async searchReservations(companyId: number): Promise<Reservation[]> {
        const bookings: Reservation[] = [];
        const deadline = Date.now() + 20_000;
        let continuationToken: string | undefined;
        const seenTokens = new Set<string>();
        for (let page = 0; page < 50; page++) {
            if (Date.now() > deadline) throw new AutocabRequestError('Tempo da busca de reservas esgotado; nenhum aviso enviado');
            const response = await this.sendRequest('/booking/v1/1.2/search', 'POST', {
                companyIds: [companyId], types: ['Advanced', 'Active', 'Mobile', 'Dispatched'],
                ...(continuationToken ? { continuationToken } : {})
            });
            const result = requireObject(await response.json());
            if (!Array.isArray(result.bookings))
                throw new AutocabRequestError('Busca de reservas sem lista bookings');
            for (const value of result.bookings) {
                const booking = requireObject(value);
                if (booking.companyId !== companyId || booking.archivedBooking != null)
                    continue;
                if (typeof booking.bookedAtTime !== 'string' || typeof booking.pickupDueTimeUtc !== 'string')
                    throw new AutocabRequestError('Reserva sem horário de criação ou pickupDueTimeUtc');
                bookings.push({ id: requireIdentifier(booking.id), companyId, bookedAtTime: booking.bookedAtTime, pickupDueTimeUtc: booking.pickupDueTimeUtc });
            }
            if (result.continuationToken == null || result.continuationToken === '')
                return bookings;
            if (typeof result.continuationToken !== 'string' || seenTokens.has(result.continuationToken))
                throw new AutocabRequestError('Paginação inválida na busca de reservas');
            continuationToken = result.continuationToken;
            seenTokens.add(continuationToken);
        }
        throw new AutocabRequestError('Busca de reservas excedeu 50 páginas; nenhum aviso enviado');
    }
    async listVehicles() { return (await this.readArray('/vehicle/v1/vehicles')).map(parseVehicle); }
    async listVehicleStatuses() { return (await this.readArray('/vehicle/v1/vehiclestatuses')).map(parseVehicleStatus); }
    async listGpsPositions() { return (await this.readArray('/vehicle/v1/vehiclegpsposition')).map(parseGpsPosition).filter(position => position !== null); }
    async findZoneByCoordinates(latitude: number, longitude: number, companyId?: number) {
        const query = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude) });
        if (companyId !== undefined)
            query.set('companyId', String(companyId));
        const responseBody = await this.readJson('/booking/v1/zone?' + query);
        if (responseBody === null)
            return null;
        return optionalIdentifier(requireObject(responseBody).id);
    }
    async applyVehiclePlot(vehicleId: number, zoneId: number, position: number) {
        const response = await this.sendRequest(`/vehicle/v1/vehicles/${vehicleId}/plot`, 'POST', { vehicleId, zoneId, position });
        await response.arrayBuffer();
        return response.status;
    }
    // "Send Message to Vehicle(s)" da Vehicle API: mensagem da central para o terminal do motorista.
    async sendDriverMessage(vehicleId: number, message: string, urgent = false) {
        const response = await this.sendRequest(this.driverMessagePath, 'POST', { companies: [], capabilities: [], zones: [], ...this.driverMessageFields, ...(urgent ? { urgent: true, companies: [], capabilities: [], zones: [] } : {}), text: message, vehicles: [vehicleId] });
        await response.arrayBuffer();
        return response.status;
    }
}
