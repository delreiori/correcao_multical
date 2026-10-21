# Multicall — correção de zonas por empresa

Core de rastreio e correção de posição trazido do projeto Cooperduque, adaptado para a Multicall, que é multiempresa: uma única Subscription Key enxerga várias empresas, separadas pelo `companyId`. São corrigidas **Arcoverde**, **São Conrado** e **Pedra da Gávea**, cada uma como uma conexão própria, com rastreio, zonas, ciclos e histórico separados.

## Empresas da Multicall

1. Configure `AUTOCAB_SUBSCRIPTION_KEY` com a chave da Multicall.
2. Liste todas as empresas da chave: `npm run companies` (local) ou `GET /api/companies` com `Authorization: Bearer <PANEL_TOKEN>` (Vercel). A resposta traz `companies` (todas as empresas: `id` e `name`) e `selected` (o companyId resolvido para cada uma das três empresas usadas, ou o erro).
3. Os companyId são resolvidos automaticamente pelo nome (sem diferenciar acentos e maiúsculas). Para fixá-los, preencha `AUTOCAB_COMPANY_ID_ARCOVERDE`, `AUTOCAB_COMPANY_ID_SAO_CONRADO` e `AUTOCAB_COMPANY_ID_PEDRA_DA_GAVEA`; o valor da variável tem prioridade sobre o nome.

O GET de empresas usa `AUTOCAB_COMPANIES_PATH` (padrão `/booking/v1/companies`). Se esse endpoint responder 404, a lista é montada a partir dos companyId presentes em zonas e veículos, sem nomes; nesse caso preencha as variáveis de companyId. Se o nome não for encontrado ou for ambíguo, o ciclo daquela empresa falha com a lista de empresas disponíveis, sem corrigir veículos de outras empresas.

Em cada ciclo as três empresas rodam, cada uma com uma parte do tempo do ciclo, considerando somente os veículos com o seu companyId e somente as suas zonas. O nome é comparado primeiro de forma exata e, se não houver, aceita um único nome que o contenha (ex.: "Arcoverde Táxi"). Se a empresa não tiver a zona `FORA DE AREA`, os ocupados dela não são movidos, mas a correção por GPS continua. O detalhe de cada ciclo mostra o companyId usado e quantos veículos da empresa foram encontrados; `GET /api/companies` mostra veículos e zonas por empresa. A quarta empresa da Multicall não é corrigida; para incluí-la, adicione uma entrada em `MULTICALL_COMPANIES` (`server/config.ts`) ou use um arquivo de conexões (`connections.example.json`).


Aplicação com Node.js 24+, TypeScript, React e PostgreSQL/Neon na Vercel; SQLite continua disponível para uso local sem DATABASE_URL. Veja [o guia de deploy](DEPLOY_VERCEL.md). Integra os endpoints presentes no `plot-zona-core.js` fornecido. Consulta zonas, GPS, status e veículos; calcula mudanças; registra intenção, envio e confirmação no banco. O frontend é somente de acompanhamento, com atualização a cada 5 segundos.

## Avisos de fila aos motoristas (Arcoverde)

Na Arcoverde, quando a posição de um motorista livre na fila de uma zona muda (pelo sistema ou não), esse motorista recebe uma mensagem urgente da central com a própria posição e a fila atualizada, por exemplo: `ARCOVERDE - Fila Praia atualizada. Você é o 2º. 1º A2 | 2º A1 | 3º A7`. Regras:

- Motorista ocupado (já trabalhando) não recebe e não aparece na fila.
- Só recebe quem está na zona que mudou; zonas protegidas (NAK, FORA DE AREA) não geram aviso.
- Fila igual à do último aviso não repete a mensagem. Na primeira leitura de cada zona a fila só é guardada.
- Só recebe quem já estava na fila e teve a própria posição alterada (alguém saiu, entrou ou foi colocado à frente dele). Vale para todos da fila; `DRIVER_MESSAGES_TOP` limita aos N primeiros, se necessário.
- Quem acabou de entrar na fila não recebe e o aviso nem é registrado.
- O texto lista os 7 primeiros e resume o restante como `+N`.

Todos os motoristas livres da zona recebem os avisos. Para testar com poucos motoristas, `DRIVER_MESSAGES_ONLY` restringe a uma lista de callsigns ou IDs separados por vírgula (ex.: `5013`); a fila listada na mensagem continua completa.

`DRIVER_MESSAGES_MODE=dry` (padrão) só registra os avisos no painel. `DRIVER_MESSAGES_MODE=live` envia de verdade, mesmo com `AUTOCAB_MODE=dry`, para testar a mensagem sem mover carros. O envio usa "Send Message to Vehicle(s)" da Vehicle API: POST em `/vehicle/v1/vehicles/message` (alterável em `AUTOCAB_DRIVER_MESSAGE_PATH`) com corpo `{ text, vehicles: [vehicleId] }`, uma requisição por motorista porque o texto traz a posição de cada um. A mensagem vai como **urgente** com o campo `urgent: true`; a especificação não documenta esse campo, então ele pode ser trocado em `AUTOCAB_DRIVER_MESSAGE_FIELDS` (JSON) se a Autocab usar outro nome. Para ligar os avisos em outra empresa, marque `driverMessages: true` nela em `MULTICALL_COMPANIES` ou no arquivo de conexões.

## Instalação e execução

```bash
npm ci
cp .env.example .env
npm run check
npm test
npm run build
npm start
```

A interface é servida na porta 3001, no loopback por padrão. Em desenvolvimento, execute `npm run server` e `npm run dev` em terminais separados. Use o checkout existente em tarefas na nuvem; a tarefa já é isolada, não é necessário criar worktree.

## Modos

- `AUTOCAB_MODE=demo`: simula uma frota local; não usa rede nem chave. Registra alterações fictícias identificadas como demonstração. As posições fictícias reiniciam com o processo; o histórico é persistente.
- `AUTOCAB_MODE=dry`: consulta a Autocab e registra o que seria alterado. Não envia POST de plot.
- `AUTOCAB_MODE=live`: consulta e envia as alterações reais pelo endpoint de plot.

O padrão é demo localmente e dry na Vercel. Consultas de zonas, veículos, status e GPS já foram verificadas com a chave disponível; nenhum POST real foi enviado. Configure `AUTOCAB_SUBSCRIPTION_KEY` no ambiente do backend ou no `.env` local, nunca no frontend, em JSON de conexões ou no controle de versão. Uma chave deve ter acesso às APIs Vehicle e Booking. Comece com dry para conferir campos, zonas e empresas. Reinicie o processo após mudar configurações. Para aplicar correções reais, defina live explicitamente.

`AUTO_START=true` inicia um ciclo na partida e repete após `CYCLE_INTERVAL_MS` (padrão 60000 ms) contados a partir do fim do ciclo. O agendador impede sobreposição neste processo. `AUTO_START=false` permite executar um ciclo via `POST /api/cycles`, com o token do painel quando configurado. O painel não dispara alterações ao atualizar os logs.

## Endpoints Autocab utilizados

Base: `https://autocab-api.azure-api.net`. Header: `Ocp-Apim-Subscription-Key`.

| Método | Caminho | Finalidade |
| --- | --- | --- |
| GET | `/booking/v1/companies` | Todas as empresas da chave (configurável em `AUTOCAB_COMPANIES_PATH`) |
| GET | `/booking/v1/zones` | Zonas visíveis à chave |
| GET | `/vehicle/v1/vehicles` | IDs, callsigns e companyId quando fornecido |
| GET | `/vehicle/v1/vehiclestatuses` | Zona atual, posição na fila, status e penalidade |
| GET | `/vehicle/v1/vehiclegpsposition` | Coordenadas dos veículos |
| GET | `/booking/v1/zone?latitude=...&longitude=...&companyId=...` | Zona correspondente ao GPS; companyId enviado quando conhecido |
| POST | `/vehicle/v1/vehicles/{vehicleId}/plot` | Corpo `{ vehicleId, zoneId, position }` |
| POST | `/vehicle/v1/vehicles/message` | Aviso de fila ao motorista; corpo `{ text, vehicles, companies, capabilities, zones }` |

Esses caminhos vêm do core fornecido. Os quatro endpoints de listas já foram verificados em consultas reais. O POST de plot foi testado apenas com respostas simuladas. O cliente espera arrays nos endpoints de lista e IDs numéricos. Em statuses, exige `id`, `vehicleStatusType` e presença de `penalty`; sem esses campos interrompe o ciclo em vez de presumir veículo livre. O GPS usa `id` ou `vehicleId` e `location.latitude/longitude`. Respostas incompatíveis aparecem no histórico de ciclos.

## Empresas e conexões

Uma chave pode retornar várias empresas ou somente a empresa à qual tem acesso. A aplicação não consegue descobrir chaves de outras empresas. As zonas são identificadas no banco por **conexão + ID**, evitando misturar IDs iguais de contas diferentes. O companyId exibido vem da resposta da API; quando ausente, o painel informa isso.

Sem arquivo de conexões, usa as três empresas da Multicall com `AUTOCAB_SUBSCRIPTION_KEY`. Para várias contas, copie `connections.example.json`, substitua IDs/nomes e configure `AUTOCAB_CONNECTIONS_FILE` com seu caminho. Cada entrada referencia somente o nome da variável com a chave. Defina os valores dessas variáveis de forma segura no backend.

É possível adicionar `companyId` numérico a uma conexão para restringir veículos àquela empresa. Nesse caso a resposta de vehicles precisa conter companyId. Não configure conexões com escopos sobrepostos para a mesma frota. Sem companyId explícito, a aplicação usa o companyId do veículo quando presente. Se houver várias empresas nas zonas e o veículo não identificar sua empresa, o ciclo falha para não adivinhar a associação.

O GET de zonas não recebe filtro não documentado: armazena as zonas retornadas pela chave. O filtro de conexão no painel identifica a origem; a coluna empresa mostra o companyId informado pela Autocab.

## Regras

1. `penalty != null`: veículo não é alterado.
2. Veículo ocupado (`Busy*` ou status contendo `ocupad`) vai para a zona configurada em `OUTSIDE_ZONE_NAME`, salvo se já estiver nela ou numa zona protegida.
3. Veículo não ocupado com GPS válido é direcionado à zona calculada pela Autocab.
4. `PROTECTED_ZONES=NAK,FORA DE AREA`: a correção por GPS não entra nessas zonas nem retira veículos delas, exceto quando um veículo livre sai de FORA DE AREA.
5. A zona de fora de área é resolvida por nome exato normalizado dentro da empresa. Ausência ou ambiguidade interrompe o planejamento. Definir `OUTSIDE_ZONE_NAME=` desativa a regra dos ocupados.
6. Sempre envia position: maior entre a posição máxima e a quantidade de veículos na zona, mais um. Envios sequenciais e reservas locais evitam atribuir a mesma posição aos veículos do mesmo ciclo.

Antes de enviar, consulta statuses novamente e cancela a alteração caso penalidade, zona ou estado de ocupado tenham mudado. A Autocab pode alterar sua fila durante a operação; não há transação distribuída nem garantia de posição permanente. Os dados fornecidos pelo core não incluem um contrato confiável de horário de GPS; não há validação de idade do GPS nesta versão.

## Logs e falhas

O banco guarda conexão, veículo, callsign, zona anterior/destino, posição enviada, motivo, coordenadas, modo, horários, HTTP e resultado. Registra a intenção antes do POST. O painel mostra os últimos 500 registros e ciclos recentes; o histórico completo permanece no SQLite.

- Simulada: planejada em dry, nenhum POST enviado.
- Confirmada: consulta posterior mostra o veículo na zona de destino. Isso não garante que a posição na fila continue igual à enviada.
- Não confirmada: POST aceito, mas a confirmação falhou ou a zona ainda não mudou.
- Resultado incerto: timeout/falha de rede/erro de servidor, ou processo interrompido durante envio.
- Rejeitada: resposta HTTP 4xx do POST.
- Ignorada: estado do veículo mudou antes do envio.

Resultados incertos/não confirmados em live bloqueiam novos envios automáticos daquele veículo. Cada ciclo reconcilia pela zona atual; ao encontrar o destino, confirma. Se não confirmar, a operação permanece bloqueada para investigação; não há botão de repetição cega. Rejeições definitivas podem ser reavaliadas em ciclos posteriores. Falhas em consultas ficam nos ciclos e não são convertidas silenciosamente em listas vazias.

Em reinício, registros pendentes viram incertos e ciclos em andamento viram interrompidos. `data/autocab.sqlite` é persistente. O banco anterior do protótipo é preservado: a tabela antiga `changes` não é apagada, mas o novo painel usa `plot_changes`, `correction_cycles` e `autocab_zones`.

## Operação

Execute **uma única instância** por banco/frota. No modo SQLite, o bloqueio é local ao processo. No modo PostgreSQL há um lease compartilhado no banco para impedir ciclos simultâneos. Faça backup consistente do SQLite com a API de backup ou com o servidor parado; não copie apenas o arquivo principal enquanto houver WAL ativo.

Para acesso remoto, configure `HOST=0.0.0.0`, `PANEL_TOKEN` forte e HTTPS em um proxy reverso. A API valida o token e a origem dos POSTs. O token digitado no painel fica apenas na memória do navegador. As Subscription Keys ficam somente no servidor. Logs não incluem credenciais nem corpos brutos de erro da Autocab.

## Organização do código

- `server/companies.ts` e `scripts/list-companies.ts`: GET de empresas e companyId usado por empresa.
- `server/autocab.ts`: requisições e interpretação das respostas Autocab.
- `server/rules.ts`: regras de escolha de zona e cálculo de fila.
- `server/correction-service.ts`: coordenação do planejamento, envio e confirmação.
- `server/repository.ts`: persistência SQLite.
- `server/postgres-repository.ts`: persistência PostgreSQL e lease.
- `server/neon-runtime.ts`: varredura da frota e inicialização do Neon.
- `api/handler.js`: entrada das funções Vercel.
- `server/scheduler.ts`: agendamento sem sobreposição.
- `server/http.ts`: API do painel e autenticação.
- `server/config.ts`: leitura/validação de configuração.
- `web/`: painel de acompanhamento.
- `shared/types.ts`: tipos compartilhados.

## Validação

`npm run check`, `npm test` e `npm run build`. Os testes usam respostas simuladas e cobrem contratos HTTP, regras de proteção/penalidade, separação de conexões, companyId, fila, falhas, persistência, recuperação, autenticação e sobreposição de ciclos. A validação remota depende da chave e das permissões reais. Não houve POST para a Autocab durante a implementação.

## Hospedagem e Vercel

A aplicação inclui backend serverless com PostgreSQL/Neon e frontend Vite. Consulte [DEPLOY_VERCEL.md](DEPLOY_VERCEL.md) para configurar variáveis, criar as tabelas automaticamente e agendar os ciclos.
