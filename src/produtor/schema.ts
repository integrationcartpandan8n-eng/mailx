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

  -- O custo de produto e o frete saíram da oferta depois que as faturas reais da Red Rock
  -- mostraram como a cobrança funciona: o pote custa o mesmo ($3,00) sendo vendido na oferta de
  -- 6, de 3 ou de 1 — o custo é do PRODUTO. E não existe "frete por venda": existe frete por
  -- ENVIO, mais taxa por pedido, mais pick por unidade, que são preços do FORNECEDOR e valem
  -- para todas as ofertas. Repetir isso em cada oferta convidava a cadastrar valores diferentes
  -- para a mesma coisa.
  ALTER TABLE produtor_ofertas DROP COLUMN IF EXISTS custo_unidade_previsto;
  ALTER TABLE produtor_ofertas DROP COLUMN IF EXISTS frete_previsto;

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
`;
