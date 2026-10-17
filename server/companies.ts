import type { CorrectionConnection } from './correction-service.ts';
import { resolveCompanyId } from './correction-service.ts';
import type { Company } from '../shared/types.ts';
export interface CompanyListing {
    companies: Company[];
    selected: { connectionId: string; name: string; companyId: number | null; error: string | null }[];
}
// GET de todas as empresas visíveis à chave e indicação de quais conexões as utilizam.
export async function listCompaniesForConnections(connections: CorrectionConnection[]): Promise<CompanyListing> {
    const gateway = connections.find(connection => connection.gateway !== null)?.gateway;
    if (!gateway)
        throw new Error('Subscription Key ausente; configure AUTOCAB_SUBSCRIPTION_KEY');
    const companies = await gateway.listCompanies();
    const selected = await Promise.all(connections.map(async connection => {
        try {
            const companyId = connection.gateway ? await resolveCompanyId(connection, connection.gateway) : undefined;
            return { connectionId: connection.id, name: connection.name, companyId: companyId ?? null, error: connection.gateway ? null : 'Subscription Key ausente' };
        }
        catch (error) {
            return { connectionId: connection.id, name: connection.name, companyId: null, error: error instanceof Error ? error.message : 'Falha ao resolver empresa' };
        }
    }));
    return { companies, selected };
}
