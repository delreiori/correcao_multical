import type { AutocabGateway } from './autocab.ts';
import type { VehicleStatus } from '../shared/types.ts';
export class DemoAutocabClient implements AutocabGateway {
    private statuses: VehicleStatus[] = [
        { vehicleId: 101, zoneId: 1, queuePosition: 1, status: 'Available', hasPenalty: false },
        { vehicleId: 102, zoneId: 2, queuePosition: 1, status: 'Busy', hasPenalty: false },
        { vehicleId: 103, zoneId: 1, queuePosition: 2, status: 'Available', hasPenalty: true },
        { vehicleId: 104, zoneId: 3, queuePosition: 1, status: 'Available', hasPenalty: false }
    ];
    async listCompanies() { return [{ id: 1, name: 'Arcoverde' }, { id: 2, name: 'São Conrado' }, { id: 3, name: 'Pedra da Gávea' }]; }
    async listZones() { return [{ id: 1, name: 'Centro', companyId: 1 }, { id: 2, name: 'Estação', companyId: 1 }, { id: 3, name: 'NAK', companyId: 1 }, { id: 4, name: 'FORA DE AREA', companyId: 1 }]; }
    async listVehicles() { return this.statuses.map(status => ({ id: status.vehicleId, callsign: String(status.vehicleId), companyId: 1 })); }
    async listVehicleStatuses() { return structuredClone(this.statuses); }
    async listGpsPositions() { return this.statuses.map(status => ({ vehicleId: status.vehicleId, latitude: -23.5, longitude: -46.6 })); }
    async findZoneByCoordinates(_latitude: number, _longitude: number, _companyId?: number): Promise<number | null> { return 2; }
    async applyVehiclePlot(vehicleId: number, zoneId: number, position: number) {
        const vehicleStatus = this.statuses.find(status => status.vehicleId === vehicleId);
        if (!vehicleStatus)
            throw new Error('Veículo de demonstração inexistente');
        vehicleStatus.zoneId = zoneId;
        vehicleStatus.queuePosition = position;
        return 200;
    }
}
