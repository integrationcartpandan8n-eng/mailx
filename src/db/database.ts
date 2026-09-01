import { Pool, PoolClient } from 'pg';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { PRODUTOR_BASE_SQL, PRODUTOR_SCHEMA_SQL, PRODUTOR_MIGRACAO_SQL } from '../produtor/schema';

let pool: Pool | null = null;
let dbReady = false;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      logger.error('DB', 'Unexpected pool error', err.message);
      dbReady = false;
    });
  }
  return pool;
}

export function isDatabaseReady(): boolean {
  return dbReady;
}

export async function initDatabase(): Promise<void> {
  try {
    const p = getPool();
    const client = await p.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS clients (
          id SERIAL PRIMARY KEY,
          company_name VARCHAR(255) NOT NULL,
          cnpj VARCHAR(20),
          website VARCHAR(255),
          contact_email VARCHAR(255) NOT NULL,
          contact_whatsapp VARCHAR(30),
          
          -- CartPanda
          cartpanda_store_url VARCHAR(255),
          cartpanda_api_token TEXT,
          
          -- ActiveCampaign
          ac_api_url VARCHAR(255),
          ac_api_key TEXT,
          ac_plan VARCHAR(50),
          
          -- DNS
          dns_registrar VARCHAR(100),
          dns_login VARCHAR(255),
          dns_manages_own BOOLEAN DEFAULT false,
          
          -- Branding
          logo_url TEXT,
          brand_color_primary VARCHAR(10),
          brand_color_secondary VARCHAR(10),
          tone_of_voice VARCHAR(50),
          
          -- Google
          google_postmaster_access BOOLEAN DEFAULT false,
          google_drive_folder_url TEXT,
          
          -- Meta
          status VARCHAR(30) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS kits (
          id SERIAL PRIMARY KEY,
          client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          slug VARCHAR(255) NOT NULL,
          price DECIMAL(10,2),

          -- ActiveCampaign IDs (populated after bootstrap)
          ac_list_id VARCHAR(50),
          ac_tag_compra_id VARCHAR(50),
          ac_tag_abandono_id VARCHAR(50),
          ac_tag_cartao_recusado_id VARCHAR(50),
          ac_tag_reembolso_id VARCHAR(50),
          ac_tag_chargeback_id VARCHAR(50),

          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS webhook_logs (
          id SERIAL PRIMARY KEY,
          client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
          event_type VARCHAR(50) NOT NULL,
          source VARCHAR(50) NOT NULL,
          payload JSONB,
          status VARCHAR(20) DEFAULT 'received',
          error TEXT,
          processed_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS store_integrations (
          id SERIAL PRIMARY KEY,
          client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
          platform VARCHAR(30) DEFAULT 'cartpanda',
          shop_slug VARCHAR(255) NOT NULL,
          api_token TEXT NOT NULL,
          events JSONB DEFAULT '{}',
          status VARCHAR(30) DEFAULT 'active',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        -- Add platform column if table already exists without it
        DO $$ BEGIN
          ALTER TABLE store_integrations ADD COLUMN IF NOT EXISTS platform VARCHAR(30) DEFAULT 'cartpanda';
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$;

        DO $$ BEGIN
          ALTER TABLE store_integrations ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$;

        -- Add new tag columns to kits if they don't exist
        ALTER TABLE kits ADD COLUMN IF NOT EXISTS ac_tag_cartao_recusado_id VARCHAR(50);
        ALTER TABLE kits ADD COLUMN IF NOT EXISTS ac_tag_reembolso_id VARCHAR(50);
        ALTER TABLE kits ADD COLUMN IF NOT EXISTS ac_tag_chargeback_id VARCHAR(50);

        -- Auto-discovery columns
        ALTER TABLE kits ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);
        ALTER TABLE kits ADD COLUMN IF NOT EXISTS platform VARCHAR(30) DEFAULT 'cartpanda';
        ALTER TABLE kits ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT false;

        -- Enable existing manually-created kits (those without external_id)
        UPDATE kits SET enabled = true WHERE external_id IS NULL AND enabled = false;

        -- Unique index for upsert by (client_id, platform, external_id)
        CREATE UNIQUE INDEX IF NOT EXISTS idx_kits_client_platform_external
          ON kits (client_id, platform, external_id)
          WHERE external_id IS NOT NULL;

        -- Add client_id to webhook_logs for per-client aggregation
        ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;

        -- Ensure unique (shop_slug, platform) combination
        CREATE UNIQUE INDEX IF NOT EXISTS idx_store_slug_platform
        ON store_integrations (shop_slug, platform);

        -- SlickText SMS integration columns on clients
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS st_api_token TEXT;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS st_brand_id VARCHAR(50);
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS default_currency VARCHAR(3) DEFAULT 'USD';

        -- SlickText list IDs on kits (per-product lists)
        ALTER TABLE kits ADD COLUMN IF NOT EXISTS st_list_compra_id VARCHAR(50);
        ALTER TABLE kits ADD COLUMN IF NOT EXISTS st_list_abandono_id VARCHAR(50);

        -- Segunda lista de compra/abandono do mesmo produto. Existe porque um produto pode ser
        -- vendido por mais de um gateway de captação de lead ao mesmo tempo (Digistore direto,
        -- JVZoo, BuyGoods como afiliado) -- confirmado com o Murilo para a família NorthScale
        -- (NeuroMind, Thermo Burn, Glyco Pulse, Max Vitalize): não importa de onde o lead veio,
        -- toda venda que fecha cai na MESMA conta Digistore cadastrada no painel. O lead de cada
        -- gateway costuma cair numa lista diferente, às vezes em conta diferente da SlickText, e
        -- as duas são leads DE VERDADE do mesmo produto -- precisam ser SOMADAS, não escolhida
        -- uma. Foi exatamente escolher a errada (a antiga, maior) que travou o card do NeuroMind
        -- por 11 dias antes de existir este segundo campo.
        ALTER TABLE kits ADD COLUMN IF NOT EXISTS st_list_compra_id_2 VARCHAR(50);
        ALTER TABLE kits ADD COLUMN IF NOT EXISTS st_list_abandono_id_2 VARCHAR(50);

        -- Fase A: colunas normalizadas para métricas multi-gateway
        DO $$ BEGIN
          ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS total_price NUMERIC(12,2);
          ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS currency VARCHAR(10);
          ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS product_name VARCHAR(255);
          ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS product_external_id VARCHAR(100);
          ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS utm_source VARCHAR(255);
          ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS utm_medium VARCHAR(255);
          ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(255);
          ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS utm_content VARCHAR(255);
          ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS utm_term VARCHAR(255);
          ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS affiliate_name VARCHAR(255);
          ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS tracking_code TEXT;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$;

        CREATE INDEX IF NOT EXISTS idx_webhook_logs_metrics
          ON webhook_logs (client_id, event_type, status, created_at);

        -- Achado em produção: "value too long for type character varying(255)" derrubando o
        -- INSERT de webhook_logs (grava-primeiro-processa-depois, ver digistore24-payment.handler)
        -- -- um payload real tinha um destes campos de texto livre vindo da Digistore/afiliado
        -- maior que 255 caracteres, e o evento nunca chegou a ser gravado (o catch só loga e
        -- segue, mas a venda em si desaparece). Esses campos são todos texto livre de fora do
        -- nosso controle (utm_*, nome de produto, nome de afiliado) -- não existe razão de negócio
        -- pra travar em 255, só o hábito de VARCHAR. ALTER COLUMN TYPE é seguro e não-destrutivo
        -- alargando (TEXT cabe tudo que VARCHAR(255) cabia), e roda toda subida sem erro mesmo já
        -- estando em TEXT (não precisa de IF NOT EXISTS pra isso).
        ALTER TABLE webhook_logs ALTER COLUMN product_name TYPE TEXT;
        ALTER TABLE webhook_logs ALTER COLUMN utm_source TYPE TEXT;
        ALTER TABLE webhook_logs ALTER COLUMN utm_medium TYPE TEXT;
        ALTER TABLE webhook_logs ALTER COLUMN utm_campaign TYPE TEXT;
        ALTER TABLE webhook_logs ALTER COLUMN utm_content TYPE TEXT;
        ALTER TABLE webhook_logs ALTER COLUMN utm_term TYPE TEXT;
        ALTER TABLE webhook_logs ALTER COLUMN affiliate_name TYPE TEXT;
        CREATE INDEX IF NOT EXISTS idx_webhook_logs_utm_source
          ON webhook_logs (utm_source) WHERE utm_source IS NOT NULL;

        -- Mapeamento manual: nossa tag interna de mensagem (ex: "CarrinhoAbandonado-MS0001A-Produto",
        -- a mesma chave usada no agrupamento do SMS granular) -> campaign_id OU workflow_id real da
        -- SlickText (ver coluna source_type abaixo). Não existe forma automática de descobrir qual
        -- workflow/campanha corresponde a qual mensagem — preenchido manualmente uma vez por produto.
        CREATE TABLE IF NOT EXISTS sms_campaign_map (
          id SERIAL PRIMARY KEY,
          client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
          utm_campaign VARCHAR(255) NOT NULL,
          slicktext_campaign_id INTEGER NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_campaign_map_unique
          ON sms_campaign_map (client_id, utm_campaign);

        -- Confirmado com o Nicollas (inspecionando o painel da SlickText) que as automações
        -- do MailX sao disparadas via Workflow, nao via Campaign avulsa -- Campaign e so pra
        -- disparos em massa manuais. slicktext_campaign_id guarda o ID de qualquer um dos
        -- dois tipos; source_type diz qual valor de source usar em GET /messages.
        ALTER TABLE sms_campaign_map ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) NOT NULL DEFAULT 'Campaign';

        -- Confirmado via análise de rede real da SlickText: quando um workflow tem várias
        -- mensagens sequenciais (ex: MS0001A/02A/03A no mesmo fluxo de abandono), cada uma tem
        -- seu próprio workflow_node_id, com envios/cliques SEPARADOS e filtráveis por período
        -- (GET /analytics/workflows/{workflow_id}/nodes/{node_id}). Quando presente, essa coluna
        -- tem prioridade sobre slicktext_campaign_id (que nesse caso guarda o workflow_id "pai").
        ALTER TABLE sms_campaign_map ADD COLUMN IF NOT EXISTS workflow_node_id INTEGER;

        -- Confirmado com o Murilo: um cliente pode rodar SMS por MAIS DE UMA conta/marca da
        -- SlickText em paralelo pro mesmo produto (ex: dois números de telefone diferentes pra
        -- escalar volume). clients.st_api_token/st_brand_id continuam sendo a "conta principal";
        -- essa tabela guarda contas ADICIONAIS do mesmo cliente. Todo lugar que consulta a
        -- SlickText pra métricas agregadas (contatos, créditos, listas) soma as duas; vínculos de
        -- mensagem específicos (sms_campaign_map) guardam qual conta usar via st_account_id.
        CREATE TABLE IF NOT EXISTS client_slicktext_accounts (
          id SERIAL PRIMARY KEY,
          client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
          label VARCHAR(255),
          st_api_token TEXT NOT NULL,
          st_brand_id VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        -- NULL = conta principal (clients.st_api_token/st_brand_id); referencia
        -- client_slicktext_accounts.id quando o vínculo é de uma conta adicional.
        ALTER TABLE sms_campaign_map ADD COLUMN IF NOT EXISTS st_account_id INTEGER REFERENCES client_slicktext_accounts(id) ON DELETE SET NULL;

        -- Confirmado com o Murilo: um cliente pode ter MAIS DE UMA conta de ActiveCampaign,
        -- com divisão de responsabilidade entre elas (ex: uma conta cuidando de compra aprovada e
        -- outra de abandono de carrinho). Mesmo desenho já usado pra SlickText: clients.ac_api_url/
        -- ac_api_key continuam sendo a conta "principal" e esta tabela guarda as ADICIONAIS.
        CREATE TABLE IF NOT EXISTS client_activecampaign_accounts (
          id SERIAL PRIMARY KEY,
          client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
          label VARCHAR(255),
          ac_api_url VARCHAR(255) NOT NULL,
          ac_api_key VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        -- Qual conta de AC atende cada produto. NULL = conta principal (clients.ac_api_url).
        -- Necessário porque as tags de um produto podem viver numa conta e não na outra.
        ALTER TABLE kits ADD COLUMN IF NOT EXISTS ac_account_id INTEGER
          REFERENCES client_activecampaign_accounts(id) ON DELETE SET NULL;

        -- Diagnóstico N8N (dump real em produção): mensagens de listas alimentadas pelo n8n
        -- usam links criados MANUALMENTE no encurtador da SlickText (source='manual', sem
        -- workflow nem node associado). Pra vincular essas utms, slicktext_campaign_id passa
        -- a aceitar NULL — source_type='ManualLink' não tem workflow/campaign; os cliques
        -- saem por link (_link_id) e envios por mensagem não existem via API.
        ALTER TABLE sms_campaign_map ALTER COLUMN slicktext_campaign_id DROP NOT NULL;

        -- Retrato diário de contatos por lista da SlickText. Existe porque a API não permite
        -- contar contatos de UMA lista dentro de UM período: /analytics/contacts ignora list_id
        -- (devolve o total do brand) e /lists/{id}/contacts/count só dá o total atual. Sem isso a
        -- Conversão por Segmento compara leads VITALÍCIOS com vendas DO PERÍODO, e a taxa sai
        -- aproximada por construção — foi a ressalva que sobrou do pedido "puxar direto da Slick".
        -- Guardando o total de cada lista uma vez por dia, leads do período passam a ser a
        -- diferença entre dois retratos, que é exato. Vale só daqui pra frente: período anterior
        -- ao primeiro retrato continua caindo no vitalício rotulado.
        -- Gravado de graça, sem chamada extra: o /stats já busca a contagem de cada lista.
        CREATE TABLE IF NOT EXISTS list_contact_snapshots (
          id SERIAL PRIMARY KEY,
          client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
          st_account_id INTEGER,
          list_id VARCHAR(64) NOT NULL,
          snapshot_date DATE NOT NULL,
          contact_count INTEGER NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );
        -- COALESCE no índice porque st_account_id nulo (conta principal, cadastro antigo) não
        -- colide com nada em UNIQUE comum e geraria uma linha nova a cada chamada do /stats.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_list_snapshot_unique
          ON list_contact_snapshots (client_id, COALESCE(st_account_id, 0), list_id, snapshot_date);
        -- Nome da lista no dia do retrato. Sem ele, diagnosticar exige cruzar ID cru com a API a
        -- cada vez: a série que provou a migração do NeuroMind era uma tabela de números como
        -- "141504" sem nenhuma indicação de que produto era. O nome vem de graça, porque a
        -- listagem que descobre as listas já o devolve.
        --
        -- Guardado por retrato, e não numa tabela de listas: lista renomeada mantém o nome que
        -- tinha no dia. Ler a série e ver o nome mudar é justamente como se descobre que alguém
        -- mexeu na conta -- que foi o que aconteceu aqui, e ninguém soube dizer quando.
        ALTER TABLE list_contact_snapshots ADD COLUMN IF NOT EXISTS list_name VARCHAR(255);

        -- Períodos em que a coleta esteve parada e NENHUMA venda foi gravada, mesmo tendo
        -- acontecido venda de verdade. Existe porque em 03/08/2026 o banco caiu, os webhooks
        -- passaram a devolver erro e a Digistore desativou sozinha as duas conexões de IPN:
        -- ficaram 4 dias sem gravar 1.023 pagamentos. Decidido não importar (o CSV do painel não
        -- traz UTM, então recuperaria total sem atribuição, com risco de estragar mais do que
        -- conserta) -- mas buraco não sinalizado APARECE COMO QUEDA DE VENDAS, e alguém lê uma
        -- falha de coleta como resultado de operação. A tela precisa dizer que não sabe.
        CREATE TABLE IF NOT EXISTS janelas_sem_coleta (
          id SERIAL PRIMARY KEY,
          client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
          fonte VARCHAR(50) NOT NULL,
          inicio TIMESTAMP NOT NULL,
          fim TIMESTAMP,
          motivo TEXT NOT NULL,
          vendas_perdidas_estimadas INTEGER,
          valor_perdido_estimado NUMERIC(12,2),
          criado_em TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_janelas_sem_coleta_periodo
          ON janelas_sem_coleta (client_id, inicio, fim);

        -- Índice único pro vigia gravar janela sem corrida: sem isso, duas execuções concorrentes
        -- (tick anterior ainda rodando quando o próximo dispara, ou mais de um processo) podem ler
        -- "não existe" ao mesmo tempo e inserir a mesma janela duas vezes -- exatamente o que
        -- alertas_enviados já evita com idx_alerta_unico. WHEN unique_violation: se por algum
        -- motivo já existir duplicata em dados legados, não trava a subida do app -- só avisa.
        --
        -- O INSERT em webhook-watchdog.ts usa ON CONFLICT DO NOTHING SEM listar as colunas
        -- (client_id, fonte, inicio) de propósito: um ON CONFLICT com alvo explícito exige que
        -- exista EXATAMENTE essa constraint/índice, e falha (42P10) em toda inserção futura, de
        -- qualquer cliente, se este índice não tiver sido criado (ex.: por causa do WARNING acima).
        -- Sem alvo, o Postgres aceita não ter nenhuma constraint pra casar -- se o índice existir,
        -- protege contra duplicata de verdade; se não existir (o caso raro que o WARNING cobre),
        -- o INSERT segue normal em vez de quebrar a gravação de janela pra todo mundo.
        DO $$ BEGIN
          CREATE UNIQUE INDEX IF NOT EXISTS idx_janela_unica
            ON janelas_sem_coleta (client_id, fonte, inicio);
        EXCEPTION WHEN unique_violation THEN
          RAISE WARNING 'janelas_sem_coleta tem linhas duplicadas de (client_id, fonte, inicio) -- índice único não criado, checar manualmente';
        END $$;

        -- Trava de repetição do vigia de webhook: sem isso um silêncio de dois dias vira um
        -- alerta a cada 30 minutos, e alerta que apita demais é alerta que se aprende a ignorar.
        -- Guardado em tabela, não em memória, porque pm2 restart zeraria a trava.
        CREATE TABLE IF NOT EXISTS alertas_enviados (
          id SERIAL PRIMARY KEY,
          client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
          tipo VARCHAR(50) NOT NULL,
          chave VARCHAR(255) NOT NULL,
          enviado_em TIMESTAMP DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_alerta_unico
          ON alertas_enviados (client_id, tipo, chave);

        -- ─────────────────────────────────────────────────────────────────────────────
        -- ESPELHO LOCAL DE ENVIOS POR MENSAGEM DE AUTOMAÇÃO
        --
        -- Por que existe: a SlickText não tem endpoint que filtre mensagens individuais por NODE
        -- e por PERÍODO ao mesmo tempo. O único caminho hoje é countWorkflowNodeMessages(), busca
        -- binária sobre GET /messages?offset=N — e foi MEDIDO em produção que /messages fica mais
        -- lenta conforme o offset cresce (paginação por OFFSET escaneia os N registros por baixo).
        -- Em offsets de ~77 mil e ~135 mil isso derrubou a requisição no timeout do nginx (502/504),
        -- mesmo com sondas em paralelo e orçamento de tempo. O botão "Calcular" dos Créditos por
        -- Automação dispara uma dessas contagens POR MENSAGEM do grupo, sequencialmente — o risco
        -- de estouro multiplica pelo número de mensagens do fluxo.
        --
        -- Mesmo desenho de list_contact_snapshots: em vez de perguntar à API toda vez, o servidor
        -- grava o que a API já respondeu. A diferença é o grão — lá é um TOTAL por dia, aqui é o
        -- EVENTO individual, porque crédito por período exige somar message_credits um a um.
        --
        -- Vale só DAQUI PRA FRENTE, de propósito: não há backfill histórico. Semear uma automação
        -- de 135 mil mensagens custaria justamente as centenas de requisições em offset alto que
        -- este espelho existe pra evitar. Período anterior à cobertura continua caindo no caminho
        -- ao vivo de hoje — zero regressão, e a cobertura cresce sozinha todo dia.
        CREATE TABLE IF NOT EXISTS automacao_envios (
          id BIGSERIAL PRIMARY KEY,
          client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
          -- NULL = conta principal. SEM REFERENCES de propósito, igual list_contact_snapshots:
          -- sms_campaign_map.st_account_id é ON DELETE SET NULL, e um FK igual aqui faria as linhas
          -- de uma conta apagada MIGRAREM em silêncio para o balde da conta principal, misturando
          -- envios de duas marcas diferentes num número só.
          st_account_id INTEGER,
          workflow_id INTEGER NOT NULL,
          node_id INTEGER NOT NULL,
          -- Campo _id do item de /messages (a sonda de ordem já confirma que ele é estável no
          -- mesmo offset entre chamadas). É o que torna a re-inserção idempotente.
          slicktext_message_id VARCHAR(64) NOT NULL,
          -- TIMESTAMP SEM FUSO, gravado com a STRING de created exatamente como veio.
          --
          -- Não é preguiça: countWorkflowNodeMessages compara created como TEXTO contra
          -- "YYYY-MM-DD 00:00:00"/"YYYY-MM-DD 23:59:59". Enquanto o fuso de created não estiver
          -- confirmado, QUALQUER conversão aqui faria o espelho e o caminho ao vivo devolverem
          -- números diferentes pro mesmo período, sem erro nenhum — e ninguém saberia qual dos dois
          -- está certo. Gravando cru e comparando cru, os dois caminhos concordam por construção.
          enviado_em TIMESTAMP NOT NULL,
          -- A string original. Custa ~30 bytes e é o que permite descobrir o fuso de created
          -- depois (e recalcular) sem ter que buscar tudo de novo na API.
          created_raw VARCHAR(40) NOT NULL,
          -- message_credits. NUMERIC e não INTEGER: o caminho ao vivo soma o valor CRU (credits +=
          -- item.message_credits), então arredondar aqui criaria divergência contra ele. NULL =
          -- campo ausente no payload; a leitura aplica o mesmo default de 1 que o ao vivo aplica.
          creditos NUMERIC(8,2),
          -- Capturados porque vêm de graça no mesmo payload. NÃO entram em nenhuma contagem (o
          -- caminho ao vivo conta toda linha que /messages devolve, e paridade vem antes de
          -- refinamento) — existem pra responder depois, sem re-espelhar, se "envio" deveria ter
          -- excluído entregas falhas ou mensagens de entrada.
          status VARCHAR(32),
          direcao VARCHAR(16),
          criado_em TIMESTAMP DEFAULT NOW()
        );

        -- Deploy parcial anterior pode ter criado a tabela sem alguma coluna — CREATE TABLE IF NOT
        -- EXISTS não conserta tabela existente, só pula.
        DO $$ BEGIN
          ALTER TABLE automacao_envios ADD COLUMN IF NOT EXISTS created_raw VARCHAR(40);
          ALTER TABLE automacao_envios ADD COLUMN IF NOT EXISTS creditos NUMERIC(8,2);
          ALTER TABLE automacao_envios ADD COLUMN IF NOT EXISTS status VARCHAR(32);
          ALTER TABLE automacao_envios ADD COLUMN IF NOT EXISTS direcao VARCHAR(16);
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$;

        -- COALESCE no st_account_id pelo mesmo motivo de idx_list_snapshot_unique: NULL não colide
        -- com NULL em UNIQUE comum, e o ON CONFLICT DO NOTHING deixaria de deduplicar exatamente
        -- nas contas principais (que são a maioria).
        CREATE UNIQUE INDEX IF NOT EXISTS idx_automacao_envios_unico
          ON automacao_envios (client_id, COALESCE(st_account_id, 0), workflow_id, node_id, slicktext_message_id);

        -- Índice de LEITURA: é ele que faz a pergunta "quantos envios/créditos deste node entre duas
        -- datas" custar milissegundos. INCLUDE (creditos) deixa a soma sair index-only, sem tocar a
        -- heap — a diferença aparece quando a tabela tiver milhões de linhas.
        CREATE INDEX IF NOT EXISTS idx_automacao_envios_periodo
          ON automacao_envios (client_id, COALESCE(st_account_id, 0), workflow_id, node_id, enviado_em)
          INCLUDE (creditos);

        -- Marca d'água da sincronização, uma linha por (cliente, conta, workflow, node).
        --
        -- A âncora (ancora_message_id/ancora_offset) é o que impede o erro silencioso: offset é
        -- POSIÇÃO, não identidade. Se a lista escorregar sob o pé — empate de created no mesmo
        -- segundo desempatado de forma diferente entre duas chamadas, ou uma mensagem removida lá
        -- atrás — avançar o offset às cegas PULA mensagem sem devolver erro nenhum. A cada tick o
        -- job relê a janela de sobreposição e procura a âncora: achou, recalibra o offset por onde
        -- ela realmente caiu; não achou, marca degradado e a leitura volta pro ao vivo.
        CREATE TABLE IF NOT EXISTS automacao_sync_estado (
          id SERIAL PRIMARY KEY,
          client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
          st_account_id INTEGER,
          workflow_id INTEGER NOT NULL,
          node_id INTEGER NOT NULL,

          -- ── semente (uma vez por node) ──
          offset_semente INTEGER,
          -- Retomada do galope entre ticks: um node de altíssimo volume pode não achar a ponta
          -- dentro do orçamento de um tick só. Sem isto, ele recomeçaria do zero pra sempre.
          semente_progresso_offset INTEGER,
          semente_em TIMESTAMP,
          -- PRIMEIRO DIA INTEIRO coberto. É o dia da primeira mensagem espelhada + 1 quando a
          -- semente não começou no offset 0: a semente cai no meio de um dia, e servir esse dia
          -- pela metade subcontaria sem avisar. Um dia a menos de cobertura é barato.
          cobre_desde DATE,
          -- totals.messages do node no instante da semente (getWorkflowNodeAnalytics, vitalício).
          -- É a régua independente: (vitalício de agora − este) deve bater com linhas_totais.
          vitalicio_na_semente INTEGER,

          -- ── marca d'água ──
          proximo_offset INTEGER NOT NULL DEFAULT 0,
          ancora_message_id VARCHAR(64),
          ancora_offset INTEGER,
          ultimo_created TIMESTAMP,

          -- ── saúde ──
          situacao VARCHAR(20) NOT NULL DEFAULT 'semente_pendente', -- semente_pendente|ativo|degradado
          motivo_degradado TEXT,
          ultima_sync_em TIMESTAMP,
          ultima_falha_em TIMESTAMP,
          ultima_falha TEXT,
          requisicoes_ultimo_tick INTEGER,
          ms_ultimo_tick INTEGER,
          deriva_ultimo_tick INTEGER,   -- quanto a âncora se moveu; != 0 é sinal de lista instável
          linhas_totais INTEGER NOT NULL DEFAULT 0,
          criado_em TIMESTAMP DEFAULT NOW(),
          atualizado_em TIMESTAMP DEFAULT NOW()
        );

        DO $$ BEGIN
          ALTER TABLE automacao_sync_estado ADD COLUMN IF NOT EXISTS semente_progresso_offset INTEGER;
          ALTER TABLE automacao_sync_estado ADD COLUMN IF NOT EXISTS vitalicio_na_semente INTEGER;
          ALTER TABLE automacao_sync_estado ADD COLUMN IF NOT EXISTS deriva_ultimo_tick INTEGER;
          ALTER TABLE automacao_sync_estado ADD COLUMN IF NOT EXISTS motivo_degradado TEXT;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_automacao_sync_estado_unico
          ON automacao_sync_estado (client_id, COALESCE(st_account_id, 0), workflow_id, node_id);

        -- COMISSÃO DE AFILIADO (skill99) POR CLIENTE
        --
        -- Card "quanto a MailX ganhou NESTE cliente" que o Nicollas pediu, dentro da mesma tela
        -- que ele já usa por cliente -- não é um total global solto. A Digistore24 não tem API de
        -- leitura pro lado de afiliado (confirmado com o suporte deles) -- só S2S Postback, que é
        -- ELES empurrando um evento por GET a cada payment/refund/chargeback da conta skill99, pra
        -- uma URL com um token secreto nosso (sem assinatura -- não existe sha_sign do lado do
        -- afiliado, só do lado de vendedor). Grava-primeiro-processa-depois, mesmo espírito do
        -- handler de webhook do produtor: um erro nosso não pode fazer a Digistore desistir de
        -- reenviar (e mais grave ainda aqui, já que não existe backfill automático -- só reenvio
        -- manual pelo suporte deles se pedirmos a tempo).
        --
        -- merchant_id vem em TODO evento (é o vendor ID da conta de produtor do cliente) -- é o que
        -- liga esse evento a um cliente nosso, via clients.digistore24_merchant_id (preenchido
        -- manualmente uma vez por cliente, mesmo padrão do sms_campaign_map). O cruzamento é feito
        -- NA LEITURA, nunca gravado aqui -- um cliente mapeado depois enxerga na hora todo o
        -- histórico que já tinha chegado, sem precisar reprocessar nada.
        CREATE TABLE IF NOT EXISTS afiliado_eventos (
          id BIGSERIAL PRIMARY KEY,
          transaction_id VARCHAR(64) NOT NULL,
          order_id VARCHAR(64) NOT NULL,
          transaction_type VARCHAR(20) NOT NULL,
          amount_affiliate NUMERIC(12,2),
          amount_brutto NUMERIC(12,2),
          amount_netto NUMERIC(12,2),
          currency VARCHAR(10),
          product_id VARCHAR(50),
          product_name TEXT,
          merchant_id VARCHAR(50),
          merchant_name TEXT,
          affiliate_name VARCHAR(100),
          billing_status VARCHAR(30),
          order_type VARCHAR(30),
          is_test BOOLEAN NOT NULL DEFAULT FALSE,
          evento_em TIMESTAMP,
          criado_em TIMESTAMP DEFAULT NOW()
        );
        -- Dedup: a Digistore reenvia o MESMO transaction_id se a nossa resposta não vier 200 a
        -- tempo -- sem alvo explícito (ver comentário de idx_janela_unica em janelas_sem_coleta)
        -- pra nunca travar o INSERT se por algum motivo este índice não existir.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_afiliado_eventos_unico
          ON afiliado_eventos (transaction_id);
        -- Leitura dos cards 1/2/5 (soma por tipo/período) e do cruzamento de order_id pros cards 3/4.
        CREATE INDEX IF NOT EXISTS idx_afiliado_eventos_merchant_periodo
          ON afiliado_eventos (merchant_id, transaction_type, evento_em)
          INCLUDE (amount_affiliate, amount_brutto, order_id, is_test);
        CREATE INDEX IF NOT EXISTS idx_afiliado_eventos_order
          ON afiliado_eventos (order_id, transaction_type, evento_em);

        -- Vendor ID da conta de produtor de CADA cliente na Digistore24 -- é o campo merchant_id
        -- que chega em afiliado_eventos. Nullable: nem todo cliente vende pela Digistore24, e
        -- mesmo quem vende pode não ter sido mapeado ainda (a tela mostra "sem vínculo
        -- configurado" nesse caso, nunca um número inventado).
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS digistore24_merchant_id VARCHAR(50);
      `);

      // Aba Produtor: tabelas próprias, num bloco próprio, com o SQL morando em
      // src/produtor/schema.ts. A fronteira entre o dado do produtor (custo, fatura, margem) e o
      // dado da MailX existe no código e no banco, não só na cabeça de quem escreveu. Roda aqui
      // junto com o resto porque schema que depende de alguém lembrar de rodar é schema que um dia
      // não existe em produção.
      // A ordem importa e é o motivo de serem três blocos. A base traz produtor_contas e
      // produtor_produtos, que a migração precisa ter para onde apontar. A migração converte um
      // banco na forma antiga (pendurada em clients/kits) e sai no primeiro comando quando não
      // encontra essa forma — no caminho normal custa uma leitura de catálogo. Só então o resto do
      // schema roda: os índices dele já falam de conta_id, que num banco não migrado ainda não
      // existiria.
      await client.query(PRODUTOR_BASE_SQL);
      await client.query(PRODUTOR_MIGRACAO_SQL);
      await client.query(PRODUTOR_SCHEMA_SQL);

      dbReady = true;
      logger.info('DB', '✅ Database tables initialized successfully');
    } finally {
      client.release();
    }
  } catch (error: any) {
    logger.warn('DB', `⚠️ Database not available: ${error.message}. Server will start without DB.`);
    dbReady = false;
  }
}

function ensureDb(): Pool {
  if (!dbReady) {
    throw new Error('Database is not connected');
  }
  return getPool();
}

/**
 * Tenta reconectar quando dbReady está false.
 *
 * Por que existe: o pool marcava dbReady = false no primeiro erro e NADA voltava a marcar true.
 * Qualquer soluço do Postgres — restart do container, conexão idle cortada, reboot da VPS — deixava
 * a aplicação convencida para sempre de que não havia banco, mesmo com o Postgres já de pé. A dash
 * ficava com o aviso vermelho até alguém dar pm2 restart, e foi o que derrubou produção em 05/08
 * sem ninguém ter mexido em nada.
 *
 * Chama initDatabase de novo em vez de só pingar: além de reconectar, ele garante o schema. Se o
 * container tiver sido recriado com volume novo, pingar responderia "conectado" com o banco vazio,
 * e cada consulta falharia por tabela inexistente — pior que continuar desconectado, porque teria
 * cara de conectado. Todo CREATE é IF NOT EXISTS, então rodar de novo é inofensivo.
 *
 * Espaçado em 5s e sem chamadas concorrentes: uma tela do dashboard dispara dezenas de consultas de
 * uma vez, e sem essa trava cada uma abriria sua própria tentativa de reconexão em cima de um banco
 * que já está em dificuldade.
 */
let reconectando = false;
let ultimaTentativaDeReconexao = 0;

async function tentarReconectar(): Promise<boolean> {
  if (dbReady) return true;
  const agora = Date.now();
  if (reconectando || agora - ultimaTentativaDeReconexao < 5000) return dbReady;
  reconectando = true;
  ultimaTentativaDeReconexao = agora;
  try {
    logger.warn('DB', 'Banco marcado como indisponível — tentando reconectar');
    await initDatabase();
    if (dbReady) logger.info('DB', '✅ Conexão com o banco restabelecida sozinha');
  } finally {
    reconectando = false;
  }
  return dbReady;
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  if (!dbReady) await tentarReconectar();
  const p = ensureDb();
  const result = await p.query(text, params);
  return result.rows as T[];
}

export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    dbReady = false;
  }
}
