/**
 * Schema da aba Produtor.
 *
 * Arquivo separado de propósito: o dado do produtor (custo, fatura do fulfillment, margem) não é
 * dado da MailX. Nenhuma tabela daqui é lida pelas telas de automação, nenhuma tabela da MailX é
 * escrita por aqui — a aba Produtor só LÊ webhook_logs para saber o que foi vendido. Prefixo
 * `produtor_` em tudo para a fronteira ser visível num `\dt` do banco.
 *
 * Rodado pelo initDatabase junto com o resto (todo CREATE é IF NOT EXISTS, reexecutar é
 * inofensivo). Não fica num script à parte porque schema que depende de alguém lembrar de rodar é
 * schema que um dia não existe em produção.
 *
 * O que NÃO tem aqui, de propósito: custo com data de vigência. O custo do fulfillment é variável e
 * quem diz o valor é a fatura — cada período guarda a sua, então o histórico nunca se reescreve.
 * Versionar o custo previsto resolveria o mesmo problema duas vezes, e a segunda solução é a que
 * dá para discordar da primeira.
 */
export const PRODUTOR_SCHEMA_SQL = `
  -- ─────────────────────────────────────────────────────────────────────
  -- Oferta = o mesmo produto vendido em embalagens diferentes (6 potes, 3
  -- potes, 1 pote). Os custos daqui são PREVISÃO: servem para ver lucro
  -- antes de a fatura chegar. Onde existe fatura, ela manda.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS produtor_ofertas (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    kit_id INTEGER NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
    nome VARCHAR(255) NOT NULL,
    unidades INTEGER NOT NULL DEFAULT 1,
    preco NUMERIC(12,2) NOT NULL,

    taxa_gateway_pct NUMERIC(6,3) NOT NULL DEFAULT 0,

    -- Comissão de afiliado. Hoje não roda afiliado nenhum, e o campo entra
    -- agora justamente por isso: no dia que ligar, é preencher o percentual —
    -- sem migração, sem recalcular histórico.
    --
    -- Percentual da OFERTA, aplicado só às vendas que têm affiliate_name
    -- preenchido. Aplicar sobre o faturamento inteiro cobraria comissão de
    -- venda direta, e como afiliado tende a ser a maior fatia, o erro não
    -- pareceria erro: só um lucro menor e plausível.
    comissao_afiliado_pct NUMERIC(6,3) NOT NULL DEFAULT 0,

    -- Como uma venda do banco é reconhecida como sendo DESTA oferta.
    -- Preenchido, casa por product_external_id (o id do produto/variante no
    -- gateway) — casamento exato. Vazio, casa por PREÇO, que é como o
    -- produtor pensa ("a de 6 potes é a de $294") e é o único critério
    -- possível quando o gateway manda um id só para todas as ofertas.
    -- Casamento por preço erra com cupom e desconto: por isso a tela sempre
    -- mostra quantas vendas do produto ficaram SEM oferta, em vez de deixar
    -- a diferença sumir dentro de um total.
    external_ids TEXT[] NOT NULL DEFAULT '{}',

    ativo BOOLEAN NOT NULL DEFAULT true,
    observacao TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_produtor_ofertas_kit
    ON produtor_ofertas (client_id, kit_id);

  -- ─────────────────────────────────────────────────────────────────────
  -- Custo unitário de cada produto, como ele aparece na fatura.
  --
  -- A coluna "nome_na_fatura" existe porque o nome do fornecedor não é o nosso: a
  -- Red Rock cobra "Divine Purity Drops" pelo que aqui é "Divine Purity",
  -- e "divinedetox" pelo Divine Detox (o upsell em cápsula). Sem o
  -- vínculo explícito, casar por semelhança erraria em silêncio.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS produtor_custo_produto (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    kit_id INTEGER NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
    nome_na_fatura VARCHAR(255) NOT NULL,
    custo_unidade NUMERIC(12,4) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_custo_produto_kit
    ON produtor_custo_produto (client_id, kit_id);

  -- ─────────────────────────────────────────────────────────────────────
  -- Tabela de preços do fulfillment.
  --
  -- Cada linha da fatura tem um DIRECIONADOR diferente, e foi isso que as
  -- 12 faturas mostraram: pick é por unidade, taxa é por pedido,
  -- embalagem é por pedido, frete é por envio. Guardar tudo como "frete"
  -- misturaria coisas que crescem por motivos diferentes.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS produtor_fulfillment (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    fornecedor VARCHAR(255) NOT NULL,

    custo_pick_unidade NUMERIC(12,4) NOT NULL DEFAULT 0,
    custo_pedido NUMERIC(12,4) NOT NULL DEFAULT 0,
    custo_embalagem_pedido NUMERIC(12,4) NOT NULL DEFAULT 0,
    custo_devolucao NUMERIC(12,4) NOT NULL DEFAULT 0,

    -- Frete NÃO é um número só, é uma faixa — e essa é a parte honesta da
    -- previsão. Nas 12 faturas ele ficou entre $0,86 e $17,12 por pedido,
    -- porque o número de ENVIOS de uma semana não é o número de PEDIDOS
    -- dela (existe defasagem entre vender e despachar) e porque o preço
    -- muda com destino e peso. Um valor único cravado erraria 17% e
    -- ninguém saberia de qual pedaço veio o erro.
    frete_pedido_min NUMERIC(12,4),
    frete_pedido_tipico NUMERIC(12,4),
    frete_pedido_max NUMERIC(12,4),

    -- Quantos PEDIDOS da fatura correspondem a cada transação do gateway.
    -- Se a operação despacha o upsell junto com o produto principal, duas
    -- transações viram um pedido só e 1.0 superestima. Começa em 1.0 e a
    -- tela mostra a razão MEDIDA contra as faturas já lançadas, em vez de
    -- alguém ter que adivinhar.
    fator_pedidos NUMERIC(6,3) NOT NULL DEFAULT 1.0,

    observacao TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_fulfillment_cliente
    ON produtor_fulfillment (client_id);

  -- ─────────────────────────────────────────────────────────────────────
  -- Vendas do produtor, vindas do export da Digistore.
  --
  -- Tabela PRÓPRIA, e não webhook_logs, por três motivos. O produto é de
  -- casa e a conta da Digistore dele não é a que alimenta a MailX, então
  -- webhook_logs não tem essas vendas. O export traz o que o webhook não
  -- traz e a previsão precisa: quantidade por linha e país de destino.
  -- E escrever em webhook_logs mexeria na tabela que a aba SMS usa.
  --
  -- Quando o IPN da conta do produtor for ligado, ele grava AQUI também —
  -- o export cobre o passado, o IPN cobre o presente, e a tela não precisa
  -- saber de qual dos dois veio cada dia.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS produtor_importacoes (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    arquivo VARCHAR(255) NOT NULL,
    linhas_lidas INTEGER NOT NULL DEFAULT 0,
    linhas_gravadas INTEGER NOT NULL DEFAULT 0,
    linhas_repetidas INTEGER NOT NULL DEFAULT 0,
    periodo_inicio DATE,
    periodo_fim DATE,
    aviso TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS produtor_vendas (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    importacao_id INTEGER REFERENCES produtor_importacoes(id) ON DELETE SET NULL,

    transacao_id VARCHAR(80) NOT NULL,
    pedido_id VARCHAR(80),
    data DATE NOT NULL,
    -- 'pagamento' | 'reembolso' | 'chargeback' | 'outro'. O tipo original fica
    -- em tipo_bruto porque a Digistore usa rótulos diferentes para a mesma
    -- coisa ("refund", "refund request", "chargeback alert") e classificar sem
    -- guardar o original impede conferir depois de que linha veio o número.
    tipo VARCHAR(20) NOT NULL,
    tipo_bruto VARCHAR(60),

    produto_id VARCHAR(80),
    produto_nome VARCHAR(255),
    quantidade INTEGER NOT NULL DEFAULT 1,
    -- Os TRES valores que o export traz, porque eles sao coisas diferentes e a conta usa o
    -- terceiro. Bruto e o que o comprador pagou (inclui imposto de venda, que nunca foi do
    -- produtor). Liquido e sem o imposto. Recebido ("Your earnings") e o que sobra depois de a
    -- Digistore ficar com a parte dela — no export real de 939 vendas, 12,5% do bruto.
    -- Guardar so o bruto obrigava a ESTIMAR a taxa do gateway por percentual, quando o valor
    -- exato vem por transacao no arquivo.
    valor_bruto NUMERIC(12,2),
    valor_liquido NUMERIC(12,2),
    valor_recebido NUMERIC(12,2),
    moeda VARCHAR(3),
    pais VARCHAR(80),
    afiliado VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
  );

  -- Reimportar o mesmo arquivo (ou um export com período sobreposto) não pode
  -- duplicar venda: o número de transação da Digistore é único e é a chave.
  -- Sem isso, subir o arquivo duas vezes dobraria o invoice previsto e
  -- pareceria crescimento.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_vendas_transacao
    ON produtor_vendas (client_id, transacao_id, COALESCE(produto_id, ''));
  CREATE INDEX IF NOT EXISTS idx_produtor_vendas_data
    ON produtor_vendas (client_id, data);

  -- ─────────────────────────────────────────────────────────────────────
  -- Fatura lançada = o custo REAL. O fornecedor manda o papel dizendo
  -- quanto foi; no período que ela cobre, ela substitui a previsão.
  --
  -- Não se chama "faturas_fulfillment" porque comissão de afiliado e
  -- extrato do gateway têm exatamente a mesma forma (fornecedor + período +
  -- valor) e cairiam numa segunda tabela idêntica. A categoria diz contra o
  -- que cada uma é comparada.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS produtor_faturas (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    kit_id INTEGER REFERENCES kits(id) ON DELETE SET NULL,
    fornecedor VARCHAR(255) NOT NULL,
    numero VARCHAR(120),

    -- 'produto' (só os potes) · 'frete' (só envio) · 'produto_frete' (a
    -- fatura fechada do fulfillment, o caso comum) · 'comissao_afiliado' ·
    -- 'taxa_gateway' · 'outros' (sem previsto correspondente: entra como
    -- custo extra, nunca como diferença contra previsão).
    categoria VARCHAR(20) NOT NULL DEFAULT 'produto_frete',

    -- Competência = o período que a fatura COBRE, não a data em que chegou.
    -- É por ela que a fatura encontra a previsão do mesmo intervalo.
    competencia_inicio DATE NOT NULL,
    competencia_fim DATE NOT NULL,
    emitida_em DATE,

    valor NUMERIC(12,2) NOT NULL,
    moeda VARCHAR(3) NOT NULL DEFAULT 'USD',

    -- Opcional. Com ela sai o custo real POR UNIDADE, que é o número que
    -- serve de sugestão para a próxima previsão.
    unidades INTEGER,

    -- 'manual' (alguém digitou olhando o PDF) ou 'redrock' (veio da API do
    -- fornecedor). A distinção existe para a sincronização nunca sobrescrever
    -- o que uma pessoa lançou: se os dois discordarem, quem decide é a pessoa,
    -- e a tela mostra os dois números lado a lado em vez de eleger um.
    origem VARCHAR(20) NOT NULL DEFAULT 'manual',
    origem_id VARCHAR(120),

    arquivo_url TEXT,
    observacao TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_produtor_faturas_kit
    ON produtor_faturas (client_id, kit_id, competencia_inicio, competencia_fim);

  -- Lançar a mesma fatura duas vezes é o erro clássico desse cadastro, e ele
  -- não aparece na tela: só faz o custo real subir e a margem parecer pior
  -- do que é. O índice recusa o duplicado quando a fatura tem número.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_faturas_numero
    ON produtor_faturas (client_id, LOWER(fornecedor), numero)
    WHERE numero IS NOT NULL;

  -- ─────────────────────────────────────────────────────────────────────
  -- Credencial de leitura de um sistema de terceiro (hoje: a Client
  -- Financial API da Red Rock).
  --
  -- Uma por cliente e por provedor. O token entra pela UI do painel e NUNCA
  -- volta por nenhuma rota: o GET devolve só os quatro últimos caracteres,
  -- o suficiente para alguém conferir que cadastrou a token que pretendia e
  -- insuficiente para reusar. Guardado em claro porque para chamar a API ele
  -- precisa ser enviado em claro — cifrar com chave no mesmo servidor
  -- protegeria contra um invasor que tem o banco e não tem o app, que não é
  -- um invasor que exista aqui. O que reduz o dano de verdade é o escopo da
  -- token (read-only, só a própria empresa) e poder revogar no portal.
  --
  -- referencia_externa guarda o id da empresa que a própria API devolve no
  -- /me. Serve para uma coisa específica: recusar uma token que é válida mas
  -- é de OUTRA empresa. Sem isso, cadastrar a token errada não daria erro —
  -- daria o custo de outra operação, e o número pareceria plausível.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS produtor_credenciais (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    provedor VARCHAR(40) NOT NULL,
    token TEXT NOT NULL,
    rotulo VARCHAR(255),
    referencia_externa VARCHAR(120),
    ultimo_ok TIMESTAMP,
    ultimo_erro TEXT,
    ultimo_erro_em TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_credenciais_provedor
    ON produtor_credenciais (client_id, provedor);

  -- ─────────────────────────────────────────────────────────────────────
  -- Espelho do que a Red Rock cobrou, pedido a pedido.
  --
  -- Isto não é previsão: é o custo REAL que o fornecedor apurou, por pedido,
  -- já quebrado em produto / fulfillment / frete / embalagem. Enquanto só
  -- havia o PDF da fatura, o custo real era um número por semana e a única
  -- forma de saber quanto custou UM pedido era dividir pela quantidade.
  --
  -- Duas colunas mudam a previsão de lugar:
  --
  --   faturado = false → o pedido existe e ainda não foi cobrado. É a
  --   explicação do buraco entre o que foi vendido numa semana e o que a
  --   fatura daquela semana traz — o pedido despacha depois.
  --
  --   aguardando_frete = true → o pedido já foi cobrado, mas SÓ a parte
  --   fixa; o frete ainda vai entrar. Sem essa coluna, esse pedido pareceria
  --   um pedido barato, e a média de custo cairia sozinha perto do fim do
  --   período — parecendo ganho de eficiência, sendo defasagem de cobrança.
  --
  -- total é NULL quando o pedido não foi faturado. NULL de propósito: zero
  -- ali significaria "custou nada", e entraria numa média como se fosse.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS produtor_redrock_pedidos (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    external_order_id VARCHAR(160) NOT NULL,
    numero_pedido VARCHAR(160),
    cliente_nome VARCHAR(255),
    pais VARCHAR(16),
    criado_em TIMESTAMP,
    faturado BOOLEAN NOT NULL DEFAULT false,
    aguardando_frete BOOLEAN NOT NULL DEFAULT false,
    total NUMERIC(12,4),
    total_produto NUMERIC(12,4),
    total_fulfillment NUMERIC(12,4),
    total_frete NUMERIC(12,4),
    total_embalagem NUMERIC(12,4),
    total_outros NUMERIC(12,4),
    faturas TEXT[] NOT NULL DEFAULT '{}',
    sincronizado_em TIMESTAMP DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_redrock_pedidos_ext
    ON produtor_redrock_pedidos (client_id, external_order_id);
  CREATE INDEX IF NOT EXISTS idx_produtor_redrock_pedidos_data
    ON produtor_redrock_pedidos (client_id, criado_em);

  -- Linha a linha da cobrança, como ela sai na fatura. Vem junto do pedido na
  -- mesma resposta, então guardar custa uma inserção e não uma requisição.
  --
  -- É o que permite responder "de onde veio esse custo" sem abrir o PDF, e é
  -- também de onde sai a COMPETÊNCIA de cada fatura: o cabeçalho da fatura só
  -- diz quando ela foi emitida, e emitir não é o período que ela cobre. A data
  -- da cobrança diz.
  CREATE TABLE IF NOT EXISTS produtor_redrock_cobrancas (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    external_order_id VARCHAR(160) NOT NULL,
    linha INTEGER NOT NULL,
    data DATE,
    atividade VARCHAR(255),
    cobranca VARCHAR(255),
    descricao TEXT,
    quantidade NUMERIC(12,4),
    valor NUMERIC(12,4),
    numero_fatura VARCHAR(160)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_redrock_cobrancas_linha
    ON produtor_redrock_cobrancas (client_id, external_order_id, linha);
  CREATE INDEX IF NOT EXISTS idx_produtor_redrock_cobrancas_fatura
    ON produtor_redrock_cobrancas (client_id, numero_fatura);
  CREATE INDEX IF NOT EXISTS idx_produtor_redrock_cobrancas_data
    ON produtor_redrock_cobrancas (client_id, data);

  -- ─────────────────────────────────────────────────────────────────────
  -- Frete médio por país, medido pelo próprio fornecedor.
  --
  -- Substitui adivinhação por medição. A faixa de frete em
  -- produtor_fulfillment nasceu de 12 faturas e erra ~17%, porque frete muda
  -- com destino e a fatura só traz o total. Aqui o número vem quebrado por
  -- país e direto de quem cobra.
  --
  -- A linha com pais = '*' é o agregado que a própria API devolve, guardado
  -- separado em vez de somado por nós: somar país a país daria um total
  -- parecido e silenciosamente diferente sempre que a API filtrar ou
  -- arredondar algo que não vemos.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS produtor_redrock_frete (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    pais VARCHAR(16) NOT NULL,
    janela_inicio DATE NOT NULL,
    janela_fim DATE NOT NULL,
    pedidos INTEGER,
    linhas_cobranca INTEGER,
    frete_total NUMERIC(12,4),
    frete_medio_pedido NUMERIC(12,4),
    sincronizado_em TIMESTAMP DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_redrock_frete_janela
    ON produtor_redrock_frete (client_id, pais, janela_inicio, janela_fim);

  -- Histórico de cada sincronização, inclusive as que falharam.
  --
  -- Existe porque a tela precisa poder dizer "o número é de ontem às 4h" e
  -- "a última tentativa falhou por isto". Sincronização que falha calada é
  -- pior que sincronização que não existe: o painel continua mostrando um
  -- número antigo com cara de número de hoje.
  CREATE TABLE IF NOT EXISTS produtor_redrock_sync (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    recurso VARCHAR(40) NOT NULL,
    periodo_inicio DATE,
    periodo_fim DATE,
    paginas INTEGER NOT NULL DEFAULT 0,
    registros INTEGER NOT NULL DEFAULT 0,
    gravados INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL,
    erro TEXT,
    duracao_ms INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_produtor_redrock_sync_cliente
    ON produtor_redrock_sync (client_id, created_at DESC);
`;
