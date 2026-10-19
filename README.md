# universal-monitor

Monitor de uptime para sites próprios, rodando em um único **Cloudflare Worker** (plano grátis).

- Checa todas as URLs cadastradas **a cada 1 minuto**.
- Avisa no **Telegram** quando um site cai e quando volta (com o tempo que ficou fora).
- Manda um **resumo diário às 22h** (horário de Brasília) dizendo que está tudo ok, ou listando o que está fora.
- Pinga o **healthchecks.io** a cada rodada. Se o próprio monitor parar, o healthchecks avisa por um canal independente.
- Painel web simples em `/admin` para adicionar e remover URLs.

Sem histórico, sem gráficos. Só o estado atual de cada site.

---

## Sumário

1. [Arquitetura](#arquitetura)
2. [Como funciona](#como-funciona)
3. [Endpoints](#endpoints)
4. [Segredos e configuração](#segredos-e-configuração)
5. [Deploy do zero](#deploy-do-zero)
6. [Operação do dia a dia](#operação-do-dia-a-dia)
7. [Desenvolvimento local](#desenvolvimento-local)
8. [Limites do plano grátis](#limites-do-plano-grátis)
9. [Solução de problemas](#solução-de-problemas)
10. [Estrutura do projeto](#estrutura-do-projeto)

---

## Arquitetura

```
                 cron * * * * *            ┌────────────┐
                 cron 0 1 * * * (22h BRT)  │  Telegram  │◄── alertas, resumo diário
                        │                  └────────────┘
                        ▼                        ▲
┌──────────┐    ┌──────────────────┐             │
│  Você    │───►│ Cloudflare Worker│─────────────┘
│ /admin   │    │  src/index.ts    │──► fetch nos sites cadastrados
└──────────┘    └────────┬─────────┘
                         │                 ┌────────────────┐
                         ├────────────────►│ healthchecks.io│──► Telegram (bot deles)
                         │  ping por rodada└────────────────┘    se o Worker parar
                         ▼
                   ┌───────────┐
                   │ D1 (SQLite)│  tabela `sites`: url, nome, status atual
                   └───────────┘
```

Três serviços independentes, zero correlação entre eles:

| Peça | Função | Se cair |
|---|---|---|
| Cloudflare Worker + D1 | Executa as checagens e guarda as URLs | healthchecks.io para de receber ping e avisa |
| Telegram (seu bot) | Entrega os alertas | Resumo das 22h não chega: sinal de que o bot morreu |
| healthchecks.io | Vigia o Worker | Worker continua alertando normalmente |

---

## Como funciona

### Checagem (cron `* * * * *`)

1. Lê todas as URLs do D1.
2. Faz `GET` em todas em paralelo. Timeout de **10 s**. Segue redirects. `cache: no-store`.
3. **No ar** = status HTTP `< 400`. Qualquer outra coisa (4xx, 5xx, timeout, DNS, TLS) = **fora**.
4. Se falhar, espera 2 s e tenta **mais uma vez** antes de considerar fora. Evita falso positivo por soluço de rede.
5. Grava no D1: `status`, `since` (quando mudou), `last_check`, `last_code`, `last_error`.
6. **Só alerta em transição**:
   - `up → down`: `🔴 Nome caiu` + URL + motivo (`HTTP 503 em 812ms`, `timeout após 10s`, etc).
   - `down → up`: `🟢 Nome voltou` + `Ficou 12 min fora`.
   - Site continua fora: silêncio. Não repete alerta a cada minuto.
7. Ao final, pinga o healthchecks.io (`POST` na ping URL).
8. Se o D1 não responder: manda `⚠️ Banco (D1) não respondeu` no Telegram e pinga `<ping-url>/fail` no healthchecks. Os dois canais disparam.

Códigos de erro da rede Cloudflare são traduzidos na mensagem:

| Código | Significado mostrado |
|---|---|
| 530 | DNS não resolve / origem inexistente |
| 521 | servidor recusou conexão |
| 522 | timeout de conexão |
| 523 | origem inalcançável |
| 525 / 526 | erro de certificado SSL |

### Resumo diário (cron `0 1 * * *`)

`01:00 UTC` = `22:00` em `America/Sao_Paulo` (Brasil não tem horário de verão desde 2019).

- Tudo ok: `✅ 19/10, 22:00 — tudo ok. 5 site(s) no ar, monitor vivo.`
- Algo fora: `⚠️ 19/10, 22:00 — 1 de 5 site(s) fora:` + lista com tempo fora.
- Nenhum site cadastrado: `ℹ️ ... monitor vivo, mas nenhum site cadastrado.`

Serve de prova de vida do bot do Telegram. Se um dia não chegar, o bot ou o Worker morreu.

### Novo site

Ao cadastrar uma URL (painel ou API), o Worker já checa na hora. O painel mostra o status real imediatamente, e se o site já estiver fora, o alerta sai no mesmo momento.

---

## Endpoints

Base: `https://universal-monitor.<sua-conta>.workers.dev`

**Todos os endpoints (exceto `/`) exigem HTTP Basic Auth** com `ADMIN_USER` / `ADMIN_PASS`.
Sem credencial, ou com credencial errada: `401` com header `WWW-Authenticate: Basic`.

Respostas são JSON (`content-type: application/json; charset=utf-8`), exceto `/admin` que é HTML.

| Método | Caminho | O que faz |
|---|---|---|
| `GET` | `/` | Redireciona (302) para `/admin` |
| `GET` | `/admin` | Painel web |
| `GET` | `/api/sites` | Lista todos os sites com estado atual |
| `POST` | `/api/sites` | Cadastra uma URL e já checa |
| `DELETE` | `/api/sites/:id` | Remove um site |
| `POST` | `/api/check` | Roda uma rodada de checagem agora (igual ao cron) |
| `POST` | `/api/test-telegram` | Envia mensagem de teste no Telegram |
| `GET` | `/api/config` | Diz se Telegram e healthchecks estão configurados |

Nos exemplos abaixo, `$A` é `usuario:senha` e `$B` é a URL base:

```bash
A='SEU_USUARIO:SUA_SENHA'
B='https://universal-monitor.<sua-conta>.workers.dev'
```

### `GET /api/sites`

```bash
curl -u "$A" "$B/api/sites"
```

```json
{
  "sites": [
    {
      "id": 1,
      "url": "https://example.com/",
      "name": "Exemplo",
      "status": "up",
      "since": 1792416135389,
      "last_check": 1792416795123,
      "last_code": 200,
      "last_error": null,
      "created_at": 1792416135108
    }
  ],
  "now": 1792416800000
}
```

Campos:

| Campo | Tipo | Significado |
|---|---|---|
| `status` | `"up" \| "down" \| "unknown"` | `unknown` só até a primeira checagem |
| `since` | epoch ms | Quando entrou no status atual. `now - since` = há quanto tempo está no ar / fora |
| `last_check` | epoch ms | Última checagem |
| `last_code` | número ou `null` | Último HTTP status. `null` se não houve resposta (timeout, DNS) |
| `last_error` | string ou `null` | Motivo da falha, `null` quando no ar |
| `now` | epoch ms | Relógio do servidor, para calcular durações no cliente |

### `POST /api/sites`

Body JSON. `url` obrigatória (`http://` ou `https://`), `name` opcional (até 80 caracteres).

```bash
curl -u "$A" -X POST "$B/api/sites" \
  -H 'content-type: application/json' \
  -d '{"url":"https://meusite.com.br","name":"Meu Site"}'
```

| Status | Quando |
|---|---|
| `201` | Criado. Retorna `{ "site": {...} }` já com o resultado da primeira checagem |
| `400` | JSON inválido, URL inválida ou protocolo diferente de http/https |
| `409` | URL já cadastrada |

A URL é normalizada (`https://meusite.com.br` vira `https://meusite.com.br/`).

### `DELETE /api/sites/:id`

```bash
curl -u "$A" -X DELETE "$B/api/sites/3"
```

| Status | Resposta |
|---|---|
| `200` | `{ "ok": true }` |
| `404` | `{ "error": "Site não encontrado" }` |

Remover um site fora do ar **não** gera mensagem de "voltou".

### `POST /api/check`

Executa uma rodada completa agora, com os mesmos efeitos do cron: grava estado, alerta transições, pinga healthchecks.

```bash
curl -u "$A" -X POST "$B/api/check"
```

```json
{ "ok": true, "checked": 5, "up": 4, "down": 1, "alerts": 1 }
```

`alerts` = quantas mensagens foram enviadas nessa rodada. Se o D1 falhar: `{ "ok": false, "checked": 0, ..., "error": "..." }`.

### `POST /api/test-telegram`

```bash
curl -u "$A" -X POST "$B/api/test-telegram"
```

```json
{ "ok": true, "configured": true }
```

`configured: false` = faltam `TELEGRAM_BOT_TOKEN` ou `TELEGRAM_CHAT_ID`. `ok: false` com `configured: true` = Telegram recusou (token inválido, bot removido do grupo). Veja `wrangler tail`.

### `GET /api/config`

```bash
curl -u "$A" "$B/api/config"
```

```json
{ "telegram": true, "healthchecks": true }
```

Não expõe valores, só se estão preenchidos.

### Erros

Qualquer exceção não tratada retorna `500` com `{ "error": "mensagem" }`. Rota desconhecida: `404` com `{ "error": "Não encontrado" }`.

---

## Segredos e configuração

Tudo sensível fica em **Cloudflare Secrets**, nunca no código nem no `wrangler.toml`.

| Nome | Obrigatório | Uso |
|---|---|---|
| `ADMIN_USER` | sim | Usuário do painel e da API |
| `ADMIN_PASS` | sim | Senha do painel e da API |
| `TELEGRAM_BOT_TOKEN` | sim | Token do bot, criado no `@BotFather` |
| `TELEGRAM_CHAT_ID` | sim | Chat que recebe os alertas. Grupo começa com `-` |
| `HEALTHCHECKS_PING_URL` | não | `https://hc-ping.com/<uuid>`. Sem ela, só não pinga |

Sem `ADMIN_USER`/`ADMIN_PASS` o Worker responde `401` para tudo.

### Arquivos locais (ignorados pelo git)

| Arquivo | Conteúdo |
|---|---|
| `.dev.vars` | Os 5 segredos acima. Usado pelo `wrangler dev` e pelo `scripts/setup.sh` |
| `.cf.env` | `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` para o wrangler autenticar sem `wrangler login` |

Modelo em `.dev.vars.example`.

### Como obter cada credencial

**Telegram**
1. Fale com `@BotFather` → `/newbot` → copie o token.
2. Adicione o bot ao grupo que vai receber alertas (ou fale com ele em privado).
3. Mande qualquer mensagem no grupo e descubra o `chat_id`:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool | grep -A3 '"chat"'
   ```

**healthchecks.io**
1. Crie conta → **Add Check** → nome `universal-monitor`.
2. Schedule: **Period 5 min, Grace 10 min** (tolera atrasos normais do cron, avisa em até 15 min).
3. Integrations → Telegram → Connect.
4. Copie a Ping URL (`https://hc-ping.com/<uuid>`).

**Cloudflare API token** (alternativa ao `wrangler login`, que pode falhar com erro de CSRF no browser)
1. `dash.cloudflare.com` → Manage Account → **Account API Tokens** → Create Token.
2. Template **Edit Cloudflare Workers** + adicione **Account → D1 → Edit**.
3. Account ID: Workers & Pages, lado direito da tela.

---

## Deploy do zero

Pré-requisito: Node 22+.

```bash
git clone <repo> universal-monitor && cd universal-monitor
npm install

cp .dev.vars.example .dev.vars        # preencha os 5 segredos
cat > .cf.env <<'EOF2'
export CLOUDFLARE_ACCOUNT_ID=<account id>
export CLOUDFLARE_API_TOKEN=<token>
EOF2
chmod 600 .cf.env

source .cf.env
./scripts/setup.sh
```

O `setup.sh` faz, nesta ordem:

1. Cria o banco D1 `universal-monitor` e grava o `database_id` no `wrangler.toml` (só na primeira vez).
2. Aplica as migrations em `migrations/` no banco remoto.
3. Sobe cada linha não vazia do `.dev.vars` como secret (`wrangler secret put`).
4. `wrangler deploy`.

Ao final imprime a URL `https://universal-monitor.<conta>.workers.dev` e os dois crons.

**Os cron triggers podem levar até ~15 min para começar a disparar após o primeiro deploy.** É propagação normal da Cloudflare, não erro. Enquanto isso, `POST /api/check` funciona.

---

## Operação do dia a dia

Sempre `source .cf.env` antes de qualquer comando `wrangler`.

| Tarefa | Comando |
|---|---|
| Atualizar código | `npm run deploy` |
| Ver logs ao vivo (crons, erros, Telegram) | `npm run tail` |
| Trocar um segredo | `npx wrangler secret put TELEGRAM_CHAT_ID` (pede o valor) |
| Listar segredos | `npx wrangler secret list` |
| Ver sites direto no banco | `npx wrangler d1 execute universal-monitor --remote --command "SELECT id,url,status FROM sites"` |
| Nova migration | criar `migrations/0002_xxx.sql` e rodar `npm run db:migrate` |
| Forçar uma rodada | `curl -u user:senha -X POST $B/api/check` |
| Pausar o monitor | Cloudflare dash → Worker → Settings → Triggers → desabilitar crons (ou `crons = []` no toml + deploy) |

Trocar o grupo do Telegram: adicione o bot no novo grupo, descubra o `chat_id` com `getUpdates`, rode `npx wrangler secret put TELEGRAM_CHAT_ID`. Não precisa redeploy.

Trocar a senha do painel: `npx wrangler secret put ADMIN_PASS`. Atualize o `.dev.vars` também, senão o próximo `setup.sh` sobrescreve.

---

## Desenvolvimento local

```bash
npm run db:migrate:local      # cria o D1 local em .wrangler/
npm run dev                   # http://127.0.0.1:8787, lê .dev.vars
```

Miniflare roda o Worker de verdade, com D1 local e acesso à internet. Os `fetch` nos sites são reais, e o Telegram e healthchecks também, se estiverem preenchidos no `.dev.vars`. Deixe `TELEGRAM_*` vazio para só logar as mensagens no console.

Disparar os crons manualmente (`--test-scheduled` já está no script `dev`):

```bash
curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"    # rodada de checagem
curl "http://127.0.0.1:8787/__scheduled?cron=0+1+*+*+*"    # resumo diário
```

Typecheck: `npm run typecheck`. Build sem publicar: `npx wrangler deploy --dry-run`.

---

## Limites do plano grátis

| Limite | Valor | Impacto |
|---|---|---|
| Requests por dia | 100.000 | Cron usa 1.440/dia. Sobra |
| Subrequests por execução | 50 | Cada site = 1 fetch (2 se falhar) + Telegram por alerta + 1 healthchecks + D1. **Confortável até ~20 sites.** Acima disso, dividir em lotes |
| CPU por execução | 10 ms | Tempo esperando resposta dos sites não conta. Ok |
| Cron triggers | 5 por Worker | Usamos 2 |
| D1 | 5 M leituras/dia, 100 k escritas/dia, 5 GB | Cron faz 1 leitura + 1 batch de escrita por minuto. Sobra |
| Cron Triggers | "best effort" | Podem atrasar ou pular execuções em incidentes. Por isso o healthchecks.io |

Fonte oficial: https://developers.cloudflare.com/workers/platform/limits/

---

## Solução de problemas

**Cron não dispara após deploy.** Espere até 15 min. Confira se está registrado:
```bash
source .cf.env
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/universal-monitor/schedules" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

**`wrangler login` falha com `request_forbidden` / `No CSRF value available in the session cookie`.** Cookie bloqueado no browser. Use API token (`.cf.env`) em vez de OAuth.

**`Authentication error [code: 10000]` ao criar D1.** Token sem permissão `D1 → Edit`. Edite o token no dash, o valor não muda.

**Painel pede senha em loop.** `ADMIN_USER`/`ADMIN_PASS` não batem ou não foram subidos. `npx wrangler secret list` para conferir.

**Telegram não chega.** `POST /api/test-telegram`. Se `configured: false`, falta secret. Se `ok: false`, veja `npm run tail`: erro `chat not found` = `chat_id` errado ou bot fora do grupo; `401 Unauthorized` = token inválido.

**Site aparece fora mas abre no browser.** Alguns sites bloqueiam bots por User-Agent ou retornam 403 para a rede da Cloudflare. O monitor manda `User-Agent: universal-monitor/1.0 (uptime check)`. Libere esse UA ou crie uma rota de health check pública no site.

**Site atrás do Cloudflare proxy.** Funciona normalmente. Se a origem cair, o status vem como 521/522/523 e a mensagem explica.

**Falso positivo isolado.** O retry de 2 s já cobre a maioria. Se persistir, aumente `RETRY_DELAY_MS` ou `CHECK_TIMEOUT_MS` em `src/index.ts`.

---

## Antes de publicar o repositório

Nada sensível é versionado: `.dev.vars` e `.cf.env` estão no `.gitignore`. Antes de um `git push` público, confirme:

```bash
git ls-files | grep -E '\.dev\.vars$|\.cf\.env$' && echo "PERIGO: arquivo de segredo rastreado"
git grep -nE '[0-9]{9,10}:[A-Za-z0-9_-]{35}|cfat_[A-Za-z0-9]+|hc-ping\.com/[0-9a-f]{8}' && echo "PERIGO: segredo no código"
```

Os dois comandos devem ficar em silêncio. O `database_id` do D1 no `wrangler.toml` não é segredo: sem token da conta ele não serve para nada.

Se um segredo vazar, revogue na origem (BotFather `/revoke`, dash da Cloudflare, healthchecks "Regenerate"), não basta apagar do git.

---

## Estrutura do projeto

```
universal-monitor/
├── src/
│   ├── index.ts          # Worker: scheduled (crons) + fetch (painel e API)
│   ├── admin.html        # painel, servido como texto pelo Worker
│   └── html.d.ts         # tipagem do import de .html
├── migrations/
│   └── 0001_init.sql     # tabela sites
├── scripts/
│   └── setup.sh          # cria D1, migra, sobe secrets, deploy
├── wrangler.toml         # nome, crons, binding D1, regra para .html
├── package.json          # scripts npm
├── tsconfig.json
├── .dev.vars.example     # modelo dos segredos
├── .dev.vars             # (ignorado) segredos reais
└── .cf.env               # (ignorado) token e account id da Cloudflare
```

Schema do D1:

```sql
CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',   -- up | down | unknown
  since INTEGER,                            -- epoch ms da última mudança de status
  last_check INTEGER,                       -- epoch ms
  last_code INTEGER,                        -- último HTTP status, NULL se sem resposta
  last_error TEXT,                          -- motivo da falha, NULL se no ar
  created_at INTEGER NOT NULL
);
```

Constantes ajustáveis em `src/index.ts`:

| Constante | Padrão | Função |
|---|---|---|
| `CHECK_TIMEOUT_MS` | 10 000 | Timeout por fetch |
| `RETRY_DELAY_MS` | 2 000 | Espera antes do retry |
| `DAILY_CRON` | `0 1 * * *` | Precisa bater com o segundo cron do `wrangler.toml` |
| `TZ` | `America/Sao_Paulo` | Fuso das mensagens |
| `USER_AGENT` | `universal-monitor/1.0 (uptime check)` | UA enviado aos sites |
