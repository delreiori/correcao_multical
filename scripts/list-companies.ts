// Uso: npm run companies — faz o GET de empresas com a chave do .env e mostra o companyId de cada uma.
import { readConfiguration } from '../server/config.ts';
import { AutocabClient } from '../server/autocab.ts';
import { listCompaniesForConnections } from '../server/companies.ts';
const configuration = readConfiguration();
const connections = configuration.connections.map(connection => {
    const key = process.env[connection.subscriptionKeyEnvironmentVariable];
    return { id: connection.id, name: connection.name, companyId: connection.companyId, companyName: connection.companyName, gateway: key ? new AutocabClient(configuration.baseUrl, key, fetch, 15000, { companiesPath: configuration.companiesPath, driverMessagePath: configuration.driverMessagePath, driverMessageFields: configuration.driverMessageFields }) : null };
});
const { companies, selected } = await listCompaniesForConnections(connections);
console.log('Empresas retornadas pela Autocab:');
console.table(companies);
console.log('Empresas usadas na correção:');
console.table(selected);
