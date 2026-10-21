# Neon e Vercel

A Vercel serve o frontend Vite e as rotas `/api/*` pela função `api/handler.js`. O backend usa PostgreSQL, não grava SQLite no filesystem da função e não inicia um timer permanente. As tabelas são criadas automaticamente no primeiro acesso autenticado, com SQL idempotente e lock de inicialização. Não é necessário colar SQL no Neon.

## Variáveis na Vercel

Em Settings → Environment Variables configure para Production:

| Variável | Finalidade |
| --- | --- |
| `DATABASE_URL` | Conexão pooled do Neon, com TLS, copiada de Connect |
| `AUTOCAB_SUBSCRIPTION_KEY` | Subscription Key da Multicall, com acesso a Vehicle e Booking |
| `AUTOCAB_COMPANY_ID_ARCOVERDE` | Opcional: companyId da Arcoverde (vazio = resolvido pelo nome) |
| `AUTOCAB_COMPANY_ID_SAO_CONRADO` | Opcional: companyId da São Conrado |
| `AUTOCAB_COMPANY_ID_PEDRA_DA_GAVEA` | Opcional: companyId da Pedra da Gávea |
| `AUTOCAB_COMPANIES_PATH` | Opcional: caminho do GET de empresas (padrão `/booking/v1/companies`) |
| `PANEL_TOKEN` | Token aleatório próprio para proteger os logs e entrar no painel |
| `CRON_SECRET` | Outro token aleatório, exclusivo do agendador |
| `CRON_REPEAT_INTERVAL_MS` | Opcional: intervalo das passadas extras dentro de cada cron (padrão 20000; 0 desliga) |
| `DRIVER_MESSAGES_MODE` | Avisos de fila da Arcoverde: `off`, `dry` (padrão, só registra) ou `live` (envia, mesmo com AUTOCAB_MODE=dry) |
| `DRIVER_MESSAGES_ONLY` | Quem recebe os avisos: callsigns/IDs separados por vírgula. Padrão `5013` (teste com o Luciano); `*` libera para todos |
| `AUTOCAB_DRIVER_MESSAGE_FIELDS` | Opcional: campos extras para enviar como urgente, em JSON (padrão `{"urgent":true}`) |
| `AUTOCAB_DRIVER_MESSAGE_PATH` | Opcional: endpoint de mensagem ao motorista (padrão `/vehicle/v1/vehicles/message`, da Vehicle API) |
| `AUTOCAB_MODE` | `dry` para validar consultas e planos sem mover veículos |

Crie os tokens em um gerenciador de senhas ou com `openssl rand -hex 32` na sua máquina. Não coloque valores em arquivos versionados, mensagens ou URLs. Digite somente PANEL_TOKEN no campo de senha do painel. A chave Autocab e a conexão Neon ficam no backend. O `.env` local não substitui as variáveis da Vercel.

Na Vercel: Framework Preset Vite, Root Directory raiz do repositório, Node.js 24, Build Command `npm run build`, Output Directory `dist`. Salve as variáveis e faça Redeploy. As consultas ao painel não iniciam correções. O histórico recebe ciclos quando o agendador chama o backend.

## Executar um primeiro ciclo

Use um cliente HTTP para fazer `POST /api/cycles` no domínio do seu deploy, com header `Authorization: Bearer <PANEL_TOKEN>`. Esse endpoint executa um ciclo e respeita AUTOCAB_MODE. Os valores entre sinais de menor/maior indicam placeholders, não valores reais. Insira o token somente na configuração privada do cliente HTTP.

Antes do primeiro ciclo, faça `GET /api/companies` com o mesmo header para listar todas as empresas da chave e conferir o companyId resolvido para Arcoverde, São Conrado e Pedra da Gávea.

Abra o painel, informe seu PANEL_TOKEN e confira as zonas e os registros de ciclos. O modo dry faz consultas reais e grava o que seria alterado. Não envia POST de plot.

## Agendamento

O endpoint do agendador é `GET /api/cron`, com `Authorization: Bearer <CRON_SECRET>`.

O projeto está configurado para o plano **Vercel Pro** informado: `vercel.json` agenda `/api/cron` a cada minuto (`* * * * *`). A Vercel envia CRON_SECRET no header Bearer. Configure esse segredo antes do Redeploy. O cron funciona no deploy de produção e não depende do painel aberto.

Não é necessário um agendador externo. Se trocar para Hobby, ajuste a frequência conforme os limites do plano ou use um agendador externo com HTTPS e header Authorization. Não configure dois agendadores para a mesma frota.

Cada execução percorre as três empresas e, em cada uma, todos os veículos daquela empresa retornados pelo endpoint de status, sem limite fixo de quantidade. O orçamento do ciclo é de 270 segundos. Somente se esse tempo for atingido, o cursor persistido no Neon permite continuar no próximo ciclo, identificado como Lote parcial. Veículos ausentes da resposta Autocab ou sem dados necessários não podem ser corrigidos. As conexões também são alternadas quando o orçamento não comporta todas. CYCLE_INTERVAL_MS controla o servidor local; não configura o cron da Vercel.

O cron da Vercel dispara no máximo uma vez por minuto. Para corrigir mais rápido, cada chamada faz novas passadas a cada `CRON_REPEAT_INTERVAL_MS` (padrão 20 s) por até 45 s, somente quando a passada anterior terminou todas as empresas. A leitura da frota (zonas, veículos, status e GPS) é feita uma vez por passada e compartilhada entre as empresas; as consultas de zona por GPS rodam 8 em paralelo; em live, os status são relidos uma vez antes dos envios e uma vez depois para confirmar o lote.

Um lease compartilhado de 360 segundos impede execução concorrente entre instâncias; a função tem duração máxima de 300 segundos. O cron continua sendo disparado a cada minuto; se o ciclo anterior ainda estiver ativo, o novo não começa. HTTP 409 indica que outra execução está ativa. Depois de um encerramento abrupto, os registros pendentes são recuperados pelo próximo ciclo após a expiração do lease. Erros de consulta/envio ficam registrados. A resposta HTTP completed indica que a execução terminou; consulte o resultado de cada ciclo.

## Ativar alterações

Depois de conferir os dados e planos em dry, configure `AUTOCAB_MODE=live` e faça novo deploy. O endpoint de plot passará a receber alterações reais. O POST real não foi executado durante o desenvolvimento.

## Desenvolvimento local

Com DATABASE_URL e PANEL_TOKEN no `.env`, `npm start` usa PostgreSQL e pode iniciar ciclos com AUTO_START. Sem DATABASE_URL usa SQLite. Os dados antigos do SQLite não são importados automaticamente para Neon. TLS e verificação de certificado são mantidos na conexão PostgreSQL.

## Validação realizada

Os testes PostgreSQL usam PGlite, um motor PostgreSQL embutido, e verificam queries, JSONB, lease, retomada de lotes e handler HTTP. As consultas reais Autocab de zonas, veículos, status e GPS foram verificadas. Um lote dry carregou 603 zonas sem enviar alterações. O Neon do usuário e o deploy Vercel não puderam ser acessados neste ambiente, pois DATABASE_URL foi configurada somente na Vercel.

## Empacotamento da função

`npm run build:api` empacota o backend TypeScript em `api/handler.js`, que também fica versionado. A função publicada importa apenas módulos Node e dependências npm; não depende de caminhos `.ts` fora do pacote. `npm run build` e `npm test` regeneram esse arquivo. Após alterações em server/, gere e inclua o JavaScript atualizado no commit.
