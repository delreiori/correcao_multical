import React, { useEffect, useMemo, useState } from 'react';
import type { DriverMessageLog, DriverMessageOutcome } from '../shared/types.ts';
import { fetchDriverMessages } from './api.ts';
const outcomeLabels: Record<DriverMessageOutcome, string> = { simulated: 'Simulada', sent: 'Enviada', failed: 'Falhou' };
const outcomeClasses: Record<DriverMessageOutcome, string> = { simulated: 'planned', sent: 'confirmed', failed: 'failed' };
function formatDate(date: string) { return new Date(date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
// Página só de leitura com o histórico dos avisos de fila enviados aos motoristas.
export function DriverMessagesPage({ panelToken, connectionId }: {
    panelToken: string;
    connectionId: string;
}) {
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
                const response = await fetchDriverMessages(panelToken, connectionId);
                if (!cancelled) {
                    setMessages(response.messages);
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
    }, [panelToken, connectionId]);
    const zoneNames = useMemo(() => [...new Set(messages.map(message => message.zoneName))].sort(), [messages]);
    const visibleMessages = messages.filter(message => (!outcomeFilter || message.outcome === outcomeFilter)
        && (!zoneFilter || message.zoneName === zoneFilter)
        && (!driverFilter || message.callsign.includes(driverFilter.trim()) || String(message.vehicleId).includes(driverFilter.trim())));
    const countOf = (outcome: DriverMessageOutcome) => messages.filter(message => message.outcome === outcome).length;
    const lastSent = messages.find(message => message.outcome === 'sent');
    return <>
 {errorMessage && <p className="message" role="alert">{errorMessage} Os dados exibidos podem estar desatualizados.</p>}
 <section className="metrics four"><article><span>Avisos registrados</span><strong>{messages.length}</strong></article><article><span>Enviados</span><strong>{countOf('sent')}</strong></article><article><span>Falharam</span><strong>{countOf('failed')}</strong></article><article><span>Só simulados</span><strong>{countOf('simulated')}</strong></article></section>
 <p className="note">{lastSent ? `Último envio: ${lastSent.callsign} em ${formatDate(lastSent.createdAt)}.` : 'Nenhum aviso enviado de verdade ainda.'} Atualiza a cada 5 segundos.</p>
 <article className="history"><h2>Avisos de fila aos motoristas <small>{visibleMessages.length} de {messages.length}</small></h2>
  <div className="filters"><label>Resultado<select value={outcomeFilter} onChange={event => setOutcomeFilter(event.target.value)}><option value="">Todos</option><option value="sent">Enviados</option><option value="failed">Falharam</option><option value="simulated">Simulados</option></select></label><label>Zona<select value={zoneFilter} onChange={event => setZoneFilter(event.target.value)}><option value="">Todas</option>{zoneNames.map(zoneName => <option key={zoneName}>{zoneName}</option>)}</select></label><label>Motorista<input value={driverFilter} onChange={event => setDriverFilter(event.target.value)} placeholder="Ex.: 5013"/></label></div>
  <div className="table"><table><thead><tr><th>Horário</th><th>Motorista</th><th>Zona</th><th>Posição</th><th>Resultado</th></tr></thead><tbody>{visibleMessages.map(message => <React.Fragment key={message.id}><tr className="clickable" onClick={() => setExpandedId(expandedId === message.id ? '' : message.id)}><td>{formatDate(message.createdAt)}</td><td><strong>{message.callsign}</strong><br /><small>{message.connectionId} · ID {message.vehicleId}</small></td><td>{message.zoneName}</td><td>{message.queuePosition}º</td><td><span className={'badge ' + outcomeClasses[message.outcome]}>{outcomeLabels[message.outcome]}</span>{message.httpStatus && <small> · HTTP {message.httpStatus}</small>}</td></tr>{expandedId === message.id && <tr><td colSpan={5} className="message-text"><div>{message.message}</div></td></tr>}</React.Fragment>)}</tbody></table>{visibleMessages.length === 0 && <p className="empty">Nenhum aviso para este filtro.</p>}</div>
  <p className="note">Toque num aviso para ver o texto que o motorista recebeu. Exibindo até 1000 avisos recentes. Só os 7 primeiros motoristas livres da fila recebem, e só quando a posição deles muda.</p>
 </article>
 </>;
}
