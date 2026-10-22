# Banco PostgreSQL e Vercel

A Vercel serve o frontend Vite e as rotas `/api/*` pela função `api/handler.js`. O backend usa PostgreSQL, não grava SQLite no filesystem da função e não inicia um timer permanente. As tabelas são criadas automaticamente no primeiro acesso autenticado, com SQL idempotente e lock de inicialização. Não é necessário colar SQL no Neon.

## Banco no Supabase

O backend usa PostgreSQL comum; funciona no Supabase (ou no Neon). As tabelas são criadas sozinhas na primeira chamada, com RLS ligado para a API pública do Supabase não expor os dados.

1. Crie o projeto no Supabase e anote a senha do banco.
2. Em **Connect**, copie a connection string do **Session pooler** (host `…pooler.supabase.com`, porta 5432) e troque `[YOUR-PASSWORD]` pela senha. Não use a conexão direta (`db.<projeto>.supabase.co`): ela é só IPv6 e a Vercel não alcança.
3. Troque `DATABASE_URL` na Vercel pela nova string e faça Redeploy. O certificado raiz do Supabase (Supabase Root 2021 CA) já vem no código e é usado automaticamente para hosts `*.supabase.com`; a verificação TLS continua ativa. `DATABASE_SSL_CA` só é necessária para outro certificado.

Se a conexão falhar, o 503 do `/api/cron` e o painel dizem o motivo: certificado não reconhecido, endereço inacessível (use o pooler), usuário/senha ou banco sem resposta. O histórico do Neon não é migrado; o Supabase começa vazio e a primeira leitura de cada fila só é guardada, sem avisos.

O histórico é limpo automaticamente uma vez por hora: ciclos com mais de 7 dias, avisos com mais de 30 e alterações com mais de 90 (alterações pendentes em live ficam).

## Variáveis na Vercel

Em Settings → Environment Variables configure para Production:

| Variável | Finalidade |
| --- | --- |
| `DATABASE_URL` | Connection string do PostgreSQL (Supabase: **Session pooler**; veja abaixo) |
| `DATABASE_SSL_CA` | Opcional: certificado PEM extra para o TLS do banco (o do Supabase já vem embutido) |
| `AUTOCAB_SUBSCRIPTION_KEY` | Subscription Key da Multicall, com acesso a Vehicle e Booking |
| `AUTOCAB_COMPANY_ID_ARCOVERDE` | Opcional: companyId da Arcoverde (vazio = resolvido pelo nome) |
| `AUTOCAB_COMPANY_ID_SAO_CONRADO` | Opcional: companyId da São Conrado |
| `AUTOCAB_COMPANY_ID_PEDRA_DA_GAVEA` | Opcional: companyId da Pedra da Gávea |
| `AUTOCAB_COMPANIES_PATH` | Opcional: caminho do GET de empresas (padrão `/booking/v1/companies`) |
| `PANEL_TOKEN` | Token aleatório próprio para proteger os logs e entrar no painel |
| `CRON_SECRET` | Outro token aleatório, exclusivo do agendador (cron-job.org) |
| `AUTOCAB_TIMEOUT_MS` | Opcional: tempo máximo de cada requisição à Autocab (padrão 10000) |
| `CRON_REPEAT_INTERVAL_MS` | Opcional: intervalo das passadas extras dentro de cada cron (padrão 20000; 0 desliga) |
| `DRIVER_MESSAGES_MODE` | Avisos de fila da Arcoverde: `off`, `dry` (padrão, só registra) ou `live` (envia, mesmo com AUTOCAB_MODE=dry) |
| `DRIVER_MESSAGES_TOP` | Opcional: limita o aviso aos N primeiros da fila. Vazio (padrão) = todos que mudaram de posição |
| `DRIVER_MESSAGES_ONLY` | Opcional: restringe quem recebe os avisos a callsigns/IDs separados por vírgula (ex.: `5013`). Vazio = todos |
| `AUTOCAB_DRIVER_MESSAGE_FIELDS` | Opcional: campos extras para enviar como urgente, em JSON (padrão `{"urgent":true}`) |
| `AUTOCAB_DRIVER_MESSAGE_PATH` | Opcional: endpoint de mensagem ao motorista (padrão `/vehicle/v1/vehicles/message`, da Vehicle API) |
| `AUTOCAB_MODE` | `dry` para validar consultas e planos sem mover veículos |

Crie os tokens em um gerenciador de senhas ou com `openssl rand -hex 32` na sua máquina. Não coloque valores em arquivos versionados, mensagens ou URLs. Digite somente PANEL_TOKEN no campo de senha do painel. A chave Autocab e a conexão Neon ficam no backend. O `.env` local não substitui as variáveis da Vercel.

Na Vercel: Framework Preset Vite, Root Directory raiz do repositório, Node.js 24, Build Command `npm run build`, Output Directory `dist`. Salve as variáveis e faça Redeploy. As consultas ao painel não iniciam correções. O histórico recebe ciclos quando o agendador chama o backend.

## Executar um primeiro ciclo

Use um cliente HTTP para fazer `POST /api/cycles` no domínio do seu deploy, com header `Authorization: Bearer <PANEL_TOKEN>`. Esse endpoint executa um ciclo e respeita AUTOCAB_MODE. Os valores entre sinais de menor/maior indicam placeholders, não valores reais. Insira o token somente na configuração privada do cliente HTTP.

Antes do primeiro ciclo, faça `GET /api/companies` com o mesmo header para listar todas as empresas da chave e conferir o companyId resolvido para Arcoverde, São Conrado e Pedra da Gávea.

Abra o painel, informe seu PANEL_TOKEN e confira as zonas e os registros de ciclos. O modo dry faz consultas reais e grava o que seria alterado. Não envia POST de plot.

## Agendamento (cron-job.org)

O agendador é o **cron-job.org**; o `vercel.json` não tem cron, para não haver dois agendadores na mesma frota. Configure o job assim:

| Campo | Valor |
| --- | --- |
| URL | `https://<domínio de produção>/api/cron` (de Settings → Domains; não use a URL de um deploy específico) |
| Método | `GET` |
| Agendamento | A cada minuto |
| Header | `Authorization: Bearer <CRON_SECRET>` (o mesmo valor configurado na Vercel) |

O endpoint responde **202** em poucos segundos e continua o ciclo em segundo plano (`waitUntil` da Vercel), então o limite de 30 s do cron-job.org não interrompe a correção. O resultado de cada ciclo fica no painel e nos logs da função. Respostas 401 indicam header ausente ou errado; 503 traz no corpo a variável ou o problema do backend.

Cada chamada faz uma passada e, a cada `CRON_REPEAT_INTERVAL_MS` (padrão 20 s), passadas extras enquanto a anterior terminou todas as empresas e a próxima (espera + duração da última) cabe em até 50 s, para não encavalar com o disparo seguinte. Se um disparo encontrar a execução anterior ainda rodando, ele é apenas pulado (log "Cron pulado"). A leitura da frota (zonas, veículos, status e GPS) é feita uma vez por passada e compartilhada entre as empresas; as consultas de zona por GPS rodam 8 em paralelo; em live, os status são relidos uma vez antes dos envios e uma vez depois para confirmar o lote.

Cada passada percorre as três empresas e, em cada uma, todos os veículos daquela empresa retornados pelo endpoint de status. O orçamento de uma passada é de 270 segundos; se for atingido, o cursor persistido no Neon continua no próximo ciclo (Lote parcial). Um lease compartilhado de 360 segundos impede execução concorrente entre instâncias; a função tem duração máxima de 300 segundos. Depois de um encerramento abrupto, os registros pendentes são recuperados após a expiração do lease. `POST /api/cycles` (com PANEL_TOKEN) roda uma passada e espera o resultado; responde 409 se outra execução estiver ativa. CYCLE_INTERVAL_MS controla só o servidor local.

## Ativar alterações

### Aviso de novas reservas da São Conrado (somente 6001)

Defina `RESERVATION_MESSAGES_MODE=live` em Production e publique o código atualizado.
`off` (padrão) desliga o recurso; `dry` registra simulações. Esse controle é independente
de `DRIVER_MESSAGES_MODE`, `DRIVER_MESSAGES_ONLY` e dos avisos de fila da Arcoverde.
Com `AUTOCAB_MODE=dry`, os avisos de reserva em live são reais, mas as correções de zona
continuam simuladas. `AUTOCAB_MODE=demo` nunca envia nem consulta reservas.

Cada ciclo consulta `POST /booking/v1/1.2/search` (Search v2, consulta sem alteração)
para a empresa São Conrado, informando `from` com o início da consulta e `to` com o
limite ISO `9999-12-31T23:59:59.999Z` para abranger agendamentos futuros sem depender
do período padrão da API. Se a busca retornar uma antecedência menor que 30 minutos
ou horários inválidos, confirma os dados em `GET /booking/v1/booking/{id}` antes de
decidir. Detalhes arquivados, removidos ou de outra empresa não geram aviso. O painel
identifica se os horários vieram da busca ou da consulta individual, além do tipo
Advanced/ASAP quando informado. A autorização da chave precisa incluir essa leitura.
Usa `bookedAtTime` como criação e `pickupDueTimeUtc` como
horário agendado: antecedência de **30 minutos ou mais no momento da criação**, inclusive
reservas para dias/meses depois. O aviso ocorre na primeira consulta que encontrar a nova
reserva, sujeito ao intervalo do cron e ao ciclo em andamento; não é um webhook instantâneo.

A mensagem é `nova corrida agendada checar tela de agendamentos`, enviada com `urgent: true`
exclusivamente ao veículo de callsign **6001 da São Conrado**, inclusive se ocupado.
Nunca usa 6001 como ID do veículo. Callsign ausente/duplicado bloqueia o envio.
A chave Autocab precisa autorizar Search v2 na Booking API e mensagens na Vehicle API.

Na primeira consulta habilitada, o monitor grava no PostgreSQL/Supabase o início da
observação: reservas criadas antes disso não geram aviso. Reiniciar ou republicar preserva
esse início e a deduplicação. Cada reserva tem uma intenção persistida antes do envio;
falhas/timeouts não são repetidos automaticamente, pois a Autocab pode ter recebido a
mensagem. O histórico mostra Envio pendente, Resultado incerto, Falhou ou Enviada (HTTP
aceito; não comprova leitura no terminal). A simulação tem registro separado do envio real.

As tabelas adicionais são criadas automaticamente, com RLS, na inicialização do backend.
Confira o detalhe do ciclo da São Conrado e a aba de mensagens (Agendamento #ID).
No submenu Reservas · São Conrado, “Últimas consultas de reservas” mostra a quantidade
consultada, elegível e ignorada (anterior ao monitor, menos de 30 minutos, vencida ou já
registrada). A captura de reservas ocorre antes de GPS, zonas e status, de modo que uma
falha nesses serviços não bloqueie o aviso; o detalhe da captura é preservado mesmo
quando a correção de zonas falha no restante do ciclo.
Este recurso foi validado com respostas simuladas e PostgreSQL embutido; o envio real e a
publicação na Vercel exigem validação na implantação com as credenciais existentes.

Depois de conferir os dados e planos em dry, configure `AUTOCAB_MODE=live` e faça novo deploy. O endpoint de plot passará a receber alterações reais. O POST real não foi executado durante o desenvolvimento.

## Desenvolvimento local

Com DATABASE_URL e PANEL_TOKEN no `.env`, `npm start` usa PostgreSQL e pode iniciar ciclos com AUTO_START. Sem DATABASE_URL usa SQLite. Os dados antigos do SQLite não são importados automaticamente para Neon. TLS e verificação de certificado são mantidos na conexão PostgreSQL.

## Validação realizada

Os testes PostgreSQL usam PGlite, um motor PostgreSQL embutido, e verificam queries, JSONB, lease, retomada de lotes e handler HTTP. As consultas reais Autocab de zonas, veículos, status e GPS foram verificadas. Um lote dry carregou 603 zonas sem enviar alterações. O Neon do usuário e o deploy Vercel não puderam ser acessados neste ambiente, pois DATABASE_URL foi configurada somente na Vercel.

## Empacotamento da função

`npm run build:api` empacota o backend TypeScript em `api/handler.js`, que também fica versionado. A função publicada importa apenas módulos Node e dependências npm; não depende de caminhos `.ts` fora do pacote. `npm run build` e `npm test` regeneram esse arquivo. Após alterações em server/, gere e inclua o JavaScript atualizado no commit.
