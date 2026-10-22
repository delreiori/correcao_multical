import React, { useEffect, useMemo, useState } from 'react';
import type { DriverMessageLog, DriverMessageOutcome, OperatingMode } from '../shared/types.ts';
import { fetchDriverMessages } from './api.ts';
const outcomeLabels: Record<DriverMessageOutcome, string> = { simulated: 'Simulada', sent: 'Enviada', failed: 'Falhou', pending: 'Envio pendente', unknown: 'Resultado incerto' };
const outcomeClasses: Record<DriverMessageOutcome, string> = { simulated: 'planned', sent: 'confirmed', failed: 'failed', pending: 'planned', unknown: 'failed' };
function formatDate(date: string) { return new Date(date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
// Página só de leitura com o histórico dos avisos de fila enviados aos motoristas.
export function DriverMessagesPage({ panelToken, connectionId, kind = 'queue', reservationMode, operatingMode, refreshVersion = 0 }: {
    panelToken: string;
    connectionId: string;
    kind?: 'queue' | 'reservations';
    reservationMode?: 'off' | 'dry' | 'live';
    operatingMode?: OperatingMode;
    refreshVersion?: number;
}) {
    const reservations = kind === 'reservations';
    const reservationState = operatingMode === 'demo' ? 'Demonstração · sem envio real'
        : reservationMode === 'live' ? 'Envio real habilitado'
        : reservationMode === 'dry' ? 'Somente simulação'
        : reservationMode === 'off' ? 'Avisos desativados' : 'Estado não informado';
    const [messages, setMessages] = useState<DriverMessageLog[]>([]);
    const [errorMessage, setErrorMessage] = useState('');
    const [outcomeFilter, setOutcomeFilter] = useState('');
    const [zoneFilter, setZoneFilter] = useState('');
    const [driverFilter, setDriverFilter] = useState('');
    const [expandedId, setExpandedId] = useState('');
    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        async function updateMessages() {
            try {
                const response = await fetchDriverMessages(panelToken, connectionId, kind);
                if (!cancelled) {
                    // Also separate histories when viewing an older deployment that ignores kind.
                    setMessages(response.messages.filter(message => reservations
                        ? message.connectionId === 'sao-conrado' && message.zoneId === 0 && message.queuePosition === 0
                        : !(message.zoneId === 0 && message.queuePosition === 0)));
                    setErrorMessage('');
                }
            }
            catch (error) {
                if (!cancelled)
                    setErrorMessage((error as Error).message);
            }
            finally {
                if (!cancelled)
                    timer = setTimeout(() => void updateMessages(), 5000);
            }
        }
        void updateMessages();
        return () => { cancelled = true; clearTimeout(timer); };
    }, [panelToken, connectionId, kind, reservations, refreshVersion]);
    const zoneNames = useMemo(() => [...new Set(messages.map(message => message.zoneName))].sort(), [messages]);
    const visibleMessages = messages.filter(message => (!outcomeFilter || message.outcome === outcomeFilter)
        && (!zoneFilter || message.zoneName === zoneFilter)
        && (!driverFilter || message.callsign.includes(driverFilter.trim()) || String(message.vehicleId).includes(driverFilter.trim())));
    const countOf = (outcome: DriverMessageOutcome) => messages.filter(message => message.outcome === outcome).length;
    const lastSent = messages.find(message => message.outcome === 'sent');
    return <>
 {reservations && <article className="reservation-settings" aria-label="Regras dos avisos de reservas">
  <div className="reservation-heading"><h2>Nova corrida agendada</h2><span className={'badge ' + (reservationMode === 'live' && operatingMode !== 'demo' ? 'confirmed' : 'planned')}>{reservationState}</span></div>
  <dl><div><dt>Empresa</dt><dd>São Conrado</dd></div><div><dt>Destinatário exclusivo</dt><dd>Callsign 6001</dd></div><div><dt>Antecedência na criação</dt><dd>30 minutos ou mais</dd></div><div><dt>Prioridade</dt><dd>Urgente</dd></div></dl>
  <p className="reservation-text">nova corrida agendada checar tela de agendamentos</p>
  <p className="note">O aviso é enviado quando a próxima consulta encontra uma nova reserva. Reservas anteriores ao início do monitor não geram aviso. Cada reserva é avisada uma vez ao 6001, inclusive se estiver ocupado.</p>
 </article>}
 {errorMessage && <p className="message" role="alert">{errorMessage} Os dados exibidos podem estar desatualizados.</p>}
 <section className="metrics four"><article><span>Avisos registrados</span><strong>{messages.length}</strong></article><article><span>Enviados</span><strong>{countOf('sent')}</strong></article><article><span>Requerem atenção</span><strong>{countOf('failed') + countOf('unknown') + countOf('pending')}</strong></article><article><span>Só simulados</span><strong>{countOf('simulated')}</strong></article></section>
 <p className="note">{lastSent ? `Último envio: ${lastSent.callsign} em ${formatDate(lastSent.createdAt)}.` : 'Nenhum aviso enviado de verdade ainda.'} Atualiza a cada 5 segundos.</p>
 <article className="history"><h2>{reservations ? 'Histórico de avisos de reservas' : 'Avisos de fila aos motoristas'} <small>{visibleMessages.length} de {messages.length}</small></h2>
  <div className="filters"><label>Resultado<select value={outcomeFilter} onChange={event => setOutcomeFilter(event.target.value)}><option value="">Todos</option><option value="sent">Enviados</option><option value="failed">Falharam</option><option value="simulated">Simulados</option><option value="pending">Envio pendente</option><option value="unknown">Resultado incerto</option></select></label><label>{reservations ? 'Reserva' : 'Zona'}<select value={zoneFilter} onChange={event => setZoneFilter(event.target.value)}><option value="">Todas</option>{zoneNames.map(zoneName => <option key={zoneName}>{zoneName}</option>)}</select></label><label>Motorista<input value={driverFilter} onChange={event => setDriverFilter(event.target.value)} placeholder="Ex.: 5013"/></label></div>
  <div className="table"><table><thead><tr><th>Horário</th><th>Motorista</th><th>{reservations ? 'Reserva' : 'Zona'}</th>{!reservations && <th>Posição</th>}<th>Resultado</th></tr></thead><tbody>{visibleMessages.map(message => <React.Fragment key={message.id}><tr className="clickable" onClick={() => setExpandedId(expandedId === message.id ? '' : message.id)}><td>{formatDate(message.createdAt)}</td><td><strong>{message.callsign}</strong><br /><small>{message.connectionId} · ID {message.vehicleId}</small></td><td>{message.zoneName}</td>{!reservations && <td>{message.queuePosition > 0 ? `${message.queuePosition}º` : '—'}</td>}<td><span className={'badge ' + outcomeClasses[message.outcome]}>{outcomeLabels[message.outcome]}</span>{message.httpStatus && <small> · HTTP {message.httpStatus}</small>}</td></tr>{expandedId === message.id && <tr><td colSpan={reservations ? 4 : 5} className="message-text"><div>{message.message}</div></td></tr>}</React.Fragment>)}</tbody></table>{visibleMessages.length === 0 && <p className="empty">{reservations ? 'Nenhum aviso de reserva para este filtro. Novos registros aparecerão após as consultas.' : 'Nenhum aviso para este filtro.'}</p>}</div>
  <p className="note">Toque num aviso para ver o texto que o motorista recebeu. Exibindo até 1000 avisos recentes. {reservations ? 'Enviada indica aceitação pela API, sem confirmação de leitura pelo motorista. Envios pendentes ou incertos não são repetidos automaticamente.' : 'Recebe só o motorista livre que já estava na fila e teve a própria posição alterada.'}</p>
 </article>
 </>;
}
