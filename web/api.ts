import type { DashboardData, SystemStatus } from '../shared/types.ts';
async function readResponseBody(response: Response): Promise<unknown> {
    const responseText = await response.text();
    try {
        return JSON.parse(responseText);
    } catch {
        if (response.status >= 500) {
            throw new Error(`O backend falhou na Vercel (HTTP ${response.status}). Consulte os logs da função e confirme o último deploy.`);
        }
        if (response.status === 401 || response.status === 403) {
            throw new Error('Acesso bloqueado. Confira o token do painel e a proteção do deploy na Vercel.');
        }
        throw new Error(`A API retornou uma resposta inesperada (HTTP ${response.status}). Confira as rotas /api do deploy.`);
    }
}
async function requestJson<ResponseBody>(path: string, panelToken: string, method = 'GET'): Promise<ResponseBody> {
    const response = await fetch('/api/' + path, { method, headers: panelToken ? { Authorization: `Bearer ${panelToken}` } : {} });
    const responseBody = await readResponseBody(response);
    if (!response.ok) {
        const errorMessage = responseBody && typeof responseBody === 'object' && 'error' in responseBody && typeof responseBody.error === 'string'
            ? responseBody.error : 'Falha ao consultar o painel';
        throw new Error(errorMessage);
    }
    return responseBody as ResponseBody;
}
export function fetchSystemStatus(panelToken: string) { return requestJson<SystemStatus>('status', panelToken); }
export function fetchDashboard(panelToken: string, connectionId: string) {
    const query = connectionId ? '?' + new URLSearchParams({ connectionId }) : '';
    return requestJson<DashboardData>('dashboard' + query, panelToken);
}
