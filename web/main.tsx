import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DashboardData, SystemStatus, ChangeOutcome, ChangeLog, CycleLog, SavedZone } from '../shared/types.ts';
import { fetchDashboard, fetchSystemStatus } from './api.ts';
import './style.css';
const outcomeLabels: Record<ChangeOutcome, string> = { planned: 'Simulada', pending: 'Enviando', confirmed: 'Confirmada', unconfirmed: 'Aguardando confirmação', unknown: 'Resultado incerto', failed: 'Rejeitada', skipped: 'Ignorada' };
const modeLabels = { demo: 'Demonstração', dry: 'Simulação · dados reais', live: 'Autocab · alterações ativas' };
function formatDate(date: string) { return new Date(date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
function ChangeHistory({ changes }: {
    changes: ChangeLog[];
}) {
    return <article className="history"><h2>Alterações de zona e fila</h2><div className="table"><table><thead><tr><th>Horário</th><th>Conexão / veículo</th><th>Zona anterior → destino</th><th>Posição enviada</th><th>Motivo</th><th>Resultado</th><th>Detalhes</th></tr></thead><tbody>{changes.map(change => <tr key={change.id}><td>{formatDate(change.createdAt)}</td><td><strong>{change.callsign}</strong><br /><small>{change.connectionId} · ID {change.vehicleId}</small></td><td>{change.previousZoneName} → {change.targetZoneName}</td><td>{change.position}</td><td>{change.reason === 'gps' ? 'Correção por GPS' : 'Ocupado → fora de área'}</td><td><span className={'badge ' + change.outcome}>{outcomeLabels[change.outcome]}</span><br /><small>{modeLabels[change.mode]}</small></td><td>{change.detail || '—'}{change.httpStatus && <small> · HTTP {change.httpStatus}</small>}</td></tr>)}</tbody></table>{changes.length === 0 && <p className="empty">Nenhuma alteração registrada para este filtro.</p>}</div><p className="note">Horários de Brasília. Exibindo até 500 registros recentes. A posição na fila pode avançar após o envio.</p></article>;
}
function CycleHistory({ cycles }: {
    cycles: CycleLog[];
}) {
    const labels: Record<string, string> = { running: 'Em andamento', partial: 'Lote parcial', completed: 'Concluído', failed: 'Falhou', interrupted: 'Interrompido' };
    return <article><h2>Ciclos de consulta</h2><div className="table"><table><thead><tr><th>Início</th><th>Conexão</th><th>Verificados</th><th>Planejados</th><th>Estado</th></tr></thead><tbody>{cycles.slice(0, 15).map(cycle => <tr key={cycle.id}><td>{formatDate(cycle.startedAt)}</td><td>{cycle.connectionId}</td><td>{cycle.inspected}</td><td>{cycle.planned}</td><td>{labels[cycle.outcome] || cycle.outcome}{cycle.detail && <p className="note">{cycle.detail}</p>}</td></tr>)}</tbody></table>{!cycles.length && <p className="empty">Aguardando o primeiro ciclo.</p>}</div></article>;
}
function ZoneList({ zones }: {
    zones: SavedZone[];
}) {
    return <article><h2>Zonas consultadas <small>{zones.length} zonas</small></h2><div className="zones">{zones.map(zone => <div className="vehicle" key={zone.connectionId + ':' + zone.id}><div><strong>{zone.name}</strong><br /><small>{zone.connectionId} · empresa {zone.companyId ?? 'não informada'} · ID {zone.id}</small></div><span title={formatDate(zone.updatedAt)}>Consultada</span></div>)}</div>{!zones.length && <p>Nenhuma zona carregada. Consulte o estado da conexão nos ciclos.</p>}</article>;
}
function Dashboard() {
    const [panelToken, setPanelToken] = useState('');
    const [tokenInput, setTokenInput] = useState('');
    const [connectionId, setConnectionId] = useState('');
    const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
    const [dashboard, setDashboard] = useState<DashboardData>({ changes: [], cycles: [], zones: [], totalChanges: 0 });
    const [errorMessage, setErrorMessage] = useState('');
    const [lastUpdated, setLastUpdated] = useState('');
    const [refreshVersion, setRefreshVersion] = useState(0);
    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        async function updateDashboard() {
            try {
                const [statusResponse, dashboardResponse] = await Promise.all([fetchSystemStatus(panelToken), fetchDashboard(panelToken, connectionId)]);
                if (!cancelled) {
                    setSystemStatus(statusResponse);
                    setDashboard(dashboardResponse);
                    setErrorMessage('');
                    setLastUpdated(new Date().toISOString());
                }
            }
            catch (error) {
                if (!cancelled)
                    setErrorMessage((error as Error).message);
            }
            finally {
                if (!cancelled)
                    timer = setTimeout(() => void updateDashboard(), 5000);
            }
        }
        void updateDashboard();
        return () => { cancelled = true; clearTimeout(timer); };
    }, [panelToken, connectionId, refreshVersion]);
    const confirmedCount = dashboard.changes.filter(change => change.outcome === 'confirmed').length;
    const attentionCount = dashboard.changes.filter(change => ['unknown', 'failed', 'unconfirmed'].includes(change.outcome)).length;
    return <main><header><div><span className="eyebrow">COOPERDUQUE · CONTROLE DE ZONAS</span><h1>Movimentações da frota</h1><p>Histórico automático de zonas e posições na fila.</p></div><span className="mode">{systemStatus ? modeLabels[systemStatus.mode] : 'Conectando…'}</span></header>
 {systemStatus?.mode === 'demo' && <aside>Veículos e zonas fictícios. O modo demonstração não se conecta à Autocab.</aside>}
 {systemStatus?.mode === 'dry' && <aside>Consultando dados reais. As alterações são apenas simuladas; nenhum veículo é movido.</aside>}
 <section className="access"><form onSubmit={event => { event.preventDefault(); setPanelToken(tokenInput); }}><label>Token do painel<input type="password" value={tokenInput} onChange={event => setTokenInput(event.target.value)} autoComplete="off" placeholder="Se exigido pelo servidor"/></label><button>Conectar</button></form><label>Empresa / conexão<select value={connectionId} onChange={event => setConnectionId(event.target.value)}><option value="">Todas as conexões</option>{systemStatus?.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}{connection.configured ? '' : ' · chave ausente'}</option>)}</select></label><button onClick={() => setRefreshVersion(version => version + 1)}>Atualizar</button></section>
 {errorMessage && <p className="message" role="alert">{errorMessage} Os dados exibidos podem estar desatualizados.</p>}
 <section className="metrics"><article><span>Histórico armazenado</span><strong>{dashboard.totalChanges}</strong></article><article><span>Confirmadas nos últimos 500</span><strong>{confirmedCount}</strong></article><article><span>Requerem atenção nos últimos 500</span><strong>{attentionCount}</strong></article></section>
 <p className="note" role="status">{systemStatus?.running ? 'Ciclo em execução' : systemStatus?.execution === 'serverless' ? 'Ciclos por agendamento da Vercel' : systemStatus?.autoStart ? 'Rotina automática ativa' : 'Rotina automática desativada'} · {systemStatus && systemStatus.execution !== 'serverless' ? `intervalo após cada ciclo: ${systemStatus.intervalMs / 1000}s` : ''}{lastUpdated && ` · painel atualizado ${formatDate(lastUpdated)}`}</p>
 <ChangeHistory changes={dashboard.changes}/><section className="grid lower"><CycleHistory cycles={dashboard.cycles}/><ZoneList zones={dashboard.zones}/></section></main>;
}
createRoot(document.getElementById('root')!).render(<Dashboard />);
