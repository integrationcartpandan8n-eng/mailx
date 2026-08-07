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

    custo_unidade_previsto NUMERIC(12,2) NOT NULL DEFAULT 0,
    frete_previsto NUMERIC(12,2) NOT NULL DEFAULT 0,
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
