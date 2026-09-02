/**
 * Schema da aba Produtor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A CONTA DE PRODUTOR É PRÓPRIA. O VÍNCULO COM A MAILX É PONTE, NÃO ALICERCE.
 *
 * A primeira versão disto pendurava tudo em clients(id) e kits(id), porque a premissa era "o
 * produtor é uma visão de um cliente que já existe". A premissa mudou: a DirectX é a empresa de
 * casa, vende por conta própria da Digistore e não é cliente da MailX. O modelo não tinha
 * acompanhado, e o sintoma apareceu na tela — ela abria num cliente de SMS qualquer e mostrava o
 * faturamento dele como se fosse do produtor.
 *
 * Só que a ligação existe de verdade, e no sentido contrário: a MailX vai fazer o SMS e o email da
 * DirectX. A mesma empresa é produtora de um lado e cliente do outro. Por isso
 * produtor_contas.client_id existe — e é NULLABLE e ON DELETE SET NULL, nunca CASCADE.
 *
 * Essa distinção é o ponto todo do arquivo. Com CASCADE, apagar um cliente ou um kit pela tela da
 * MailX (o painel tem os dois botões) apagaria em silêncio o custo, as ofertas, a credencial da
 * Red Rock e o histórico de faturas do produtor. Ninguém veria erro nenhum: os números só voltariam
 * a ser previsão. Com SET NULL, apagar o cliente desfaz a PONTE e não encosta no custo.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Rodado pelo initDatabase junto com o resto. Todo CREATE é IF NOT EXISTS, reexecutar é inofensivo.
 * Não fica num script à parte porque schema que depende de alguém lembrar de rodar é schema que um
 * dia não existe em produção.
 *
 * O que NÃO tem aqui, de propósito: custo com data de vigência. O custo do fulfillment é variável e
 * quem diz o valor é a fatura — cada período guarda a sua, então o histórico nunca se reescreve.
 * Versionar o custo previsto resolveria o mesmo problema duas vezes, e a segunda solução é a que
 * dá para discordar da primeira.
 */
/**
 * As duas tabelas que sustentam o resto, num bloco próprio porque a MIGRAÇÃO precisa delas antes
 * de existir. É por isso que estão separadas: rodar o schema inteiro primeiro não funciona — os
 * índices dele já falam de conta_id, que num banco na forma antiga ainda não existe.
 *
 * Ordem em initDatabase: base → migração → resto do schema.
 */
export const PRODUTOR_BASE_SQL = `
  -- ─────────────────────────────────────────────────────────────────────
  -- Conta de produtor: a empresa que VENDE o produto e paga o custo dele.
  --
  -- client_id é a ponte opcional para a MailX, para o caso em que a mesma
  -- empresa é produtora e também cliente de SMS/email. Preenchido, a tela
  -- pode mostrar as vendas que chegam por webhook ao lado das importadas,
  -- dizendo de qual origem veio cada uma. Vazio, a conta vive sozinha — que
  -- é o estado normal de um produtor que não é cliente.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS produtor_contas (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    moeda VARCHAR(3) NOT NULL DEFAULT 'USD',
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    ativo BOOLEAN NOT NULL DEFAULT true,
    observacao TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_contas_nome
    ON produtor_contas (LOWER(nome));
  -- Um cliente da MailX é ponte de no máximo uma conta de produtor. Sem isto,
  -- duas contas apontando para o mesmo cliente leriam as MESMAS vendas por
  -- webhook e o faturamento apareceria dobrado, uma vez em cada conta.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_contas_client
    ON produtor_contas (client_id) WHERE client_id IS NOT NULL;

  -- ─────────────────────────────────────────────────────────────────────
  -- Produto do produtor.
  --
  -- Três nomes convivem para a mesma coisa e é por isso que são três colunas:
  -- "nome" é como a casa chama, "nomes_na_venda" é como a Digistore escreve
  -- no export, e "nome_na_fatura" é como a Red Rock cobra ("Divine Purity
  -- Drops" para o que aqui é "Divine Purity"). Casar por semelhança erraria
  -- em silêncio, e errar em silêncio aqui é atribuir o custo de um produto ao
  -- outro.
  --
  -- O custo unitário mora aqui, e não numa tabela à parte, porque é 1 para 1
  -- com o produto: as faturas provaram que o pote custa o mesmo na embalagem
  -- de 6, de 3 ou de 1. É do PRODUTO, não da oferta.
  --
  -- kit_id é a segunda ponte opcional: quando a conta está ligada a um
  -- cliente da MailX, ela diz qual kit daquele cliente é este produto.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS produtor_produtos (
    id SERIAL PRIMARY KEY,
    conta_id INTEGER NOT NULL REFERENCES produtor_contas(id) ON DELETE CASCADE,
    nome VARCHAR(255) NOT NULL,
    nomes_na_venda TEXT[] NOT NULL DEFAULT '{}',
    nome_na_fatura VARCHAR(255),
    custo_unidade NUMERIC(12,4),
    kit_id INTEGER REFERENCES kits(id) ON DELETE SET NULL,
    ativo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_produtos_nome
    ON produtor_produtos (conta_id, LOWER(nome));

`;

export const PRODUTOR_SCHEMA_SQL = `
  -- ─────────────────────────────────────────────────────────────────────
  -- Oferta = o mesmo produto vendido em embalagens diferentes (6 potes, 3
  -- potes, 1 pote). Os custos daqui são PREVISÃO: servem para ver lucro
  -- antes de a fatura chegar. Onde existe fatura, ela manda.
  -- ─────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS produtor_ofertas (
    id SERIAL PRIMARY KEY,
    conta_id INTEGER NOT NULL REFERENCES produtor_contas(id) ON DELETE CASCADE,
    produto_id INTEGER NOT NULL REFERENCES produtor_produtos(id) ON DELETE CASCADE,
    nome VARCHAR(255) NOT NULL,
    unidades INTEGER NOT NULL DEFAULT 1,
    preco NUMERIC(12,2) NOT NULL,

    taxa_gateway_pct NUMERIC(6,3) NOT NULL DEFAULT 0,

    -- Comissão de afiliado. Hoje não roda afiliado nenhum, e o campo entra
    -- agora justamente por isso: no dia que ligar, é preencher o percentual —
    -- sem migração, sem recalcular histórico.
    --
    -- Percentual da OFERTA, aplicado só às vendas que têm afiliado
    -- preenchido. Aplicar sobre o faturamento inteiro cobraria comissão de
    -- venda direta, e como afiliado tende a ser a maior fatia, o erro não
    -- pareceria erro: só um lucro menor e plausível.
    comissao_afiliado_pct NUMERIC(6,3) NOT NULL DEFAULT 0,

    -- Como uma venda é reconhecida como sendo DESTA oferta. Preenchido, casa
    -- por id do produto/variante no gateway — casamento exato. Vazio, casa
    -- por PREÇO, que é como o produtor pensa ("a de 6 potes é a de \$294") e é
    -- o único critério possível quando o gateway manda um id só para todas.
    -- Casamento por preço erra com cupom e imposto: por isso a tela sempre
    -- mostra quantas vendas ficaram SEM oferta, em vez de deixar a diferença
    -- sumir dentro de um total.
    external_ids TEXT[] NOT NULL DEFAULT '{}',

    ativo BOOLEAN NOT NULL DEFAULT true,
    observacao TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_produtor_ofertas_produto
    ON produtor_ofertas (conta_id, produto_id);

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
    conta_id INTEGER NOT NULL REFERENCES produtor_contas(id) ON DELETE CASCADE,
    fornecedor VARCHAR(255) NOT NULL,

    custo_pick_unidade NUMERIC(12,4) NOT NULL DEFAULT 0,
    custo_pedido NUMERIC(12,4) NOT NULL DEFAULT 0,
    custo_embalagem_pedido NUMERIC(12,4) NOT NULL DEFAULT 0,
    custo_devolucao NUMERIC(12,4) NOT NULL DEFAULT 0,

    -- Frete NÃO é um número só, é uma faixa — e essa é a parte honesta da
    -- previsão. Nas 12 faturas ele ficou entre \$0,86 e \$17,12 por pedido,
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

    -- Quantas observações sustentam a faixa de frete, e quando ela foi medida. Antes isso ia para
    -- "observacao" em texto livre que nenhuma tela lia — então a faixa aplicada perdia a procedência
    -- no instante em que era gravada, e a previsão usava um número medido em 90 dias para modelar
    -- qualquer período sem nada dizer.
    frete_medido_pedidos INTEGER,
    frete_medido_em TIMESTAMP,

    observacao TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_fulfillment_conta
    ON produtor_fulfillment (conta_id);

  -- ─────────────────────────────────────────────────────────────────────
  -- Vendas do produtor, vindas do export da Digistore.
  --
  -- Tabela PRÓPRIA, e não webhook_logs, por três motivos. A conta da
  -- Digistore do produto de casa não é a que alimenta a MailX, então
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
    conta_id INTEGER NOT NULL REFERENCES produtor_contas(id) ON DELETE CASCADE,
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
    conta_id INTEGER NOT NULL REFERENCES produtor_contas(id) ON DELETE CASCADE,
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

    -- Id do produto NO GATEWAY (o "Prd ID" da Digistore), não a FK para produtor_produtos. O nome
    -- é longo de propósito: com as duas colunas chamadas "produto_id" numa query que junta venda e
    -- oferta, trocar uma pela outra seria um erro invisível — casaria tudo com nada.
    gateway_produto_id VARCHAR(80),
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
    ON produtor_vendas (conta_id, transacao_id, COALESCE(gateway_produto_id, ''));
  CREATE INDEX IF NOT EXISTS idx_produtor_vendas_data
    ON produtor_vendas (conta_id, data);

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
    conta_id INTEGER NOT NULL REFERENCES produtor_contas(id) ON DELETE CASCADE,
    produto_id INTEGER REFERENCES produtor_produtos(id) ON DELETE SET NULL,
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
  CREATE INDEX IF NOT EXISTS idx_produtor_faturas_produto
    ON produtor_faturas (conta_id, produto_id, competencia_inicio, competencia_fim);

  -- Lançar a mesma fatura duas vezes é o erro clássico desse cadastro, e ele
  -- não aparece na tela: só faz o custo real subir e a margem parecer pior
  -- do que é. O índice recusa o duplicado quando a fatura tem número.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_faturas_numero
    ON produtor_faturas (conta_id, LOWER(fornecedor), numero)
    WHERE numero IS NOT NULL;

  -- ─────────────────────────────────────────────────────────────────────
  -- Credencial de leitura de um sistema de terceiro (hoje: a Client
  -- Financial API da Red Rock).
  --
  -- Uma por conta e por provedor. O token entra pela UI do painel e NUNCA
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
    conta_id INTEGER NOT NULL REFERENCES produtor_contas(id) ON DELETE CASCADE,
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
    ON produtor_credenciais (conta_id, provedor);

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
    conta_id INTEGER NOT NULL REFERENCES produtor_contas(id) ON DELETE CASCADE,
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
    ON produtor_redrock_pedidos (conta_id, external_order_id);
  CREATE INDEX IF NOT EXISTS idx_produtor_redrock_pedidos_data
    ON produtor_redrock_pedidos (conta_id, criado_em);

  -- Linha a linha da cobrança, como ela sai na fatura. Vem junto do pedido na
  -- mesma resposta, então guardar custa uma inserção e não uma requisição.
  --
  -- É o que permite responder "de onde veio esse custo" sem abrir o PDF, e é
  -- também de onde sai a COMPETÊNCIA de cada fatura: o cabeçalho da fatura só
  -- diz quando ela foi emitida, e emitir não é o período que ela cobre. A data
  -- da cobrança diz.
  CREATE TABLE IF NOT EXISTS produtor_redrock_cobrancas (
    id SERIAL PRIMARY KEY,
    conta_id INTEGER NOT NULL REFERENCES produtor_contas(id) ON DELETE CASCADE,
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
    ON produtor_redrock_cobrancas (conta_id, external_order_id, linha);
  CREATE INDEX IF NOT EXISTS idx_produtor_redrock_cobrancas_fatura
    ON produtor_redrock_cobrancas (conta_id, numero_fatura);
  CREATE INDEX IF NOT EXISTS idx_produtor_redrock_cobrancas_data
    ON produtor_redrock_cobrancas (conta_id, data);

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
    conta_id INTEGER NOT NULL REFERENCES produtor_contas(id) ON DELETE CASCADE,
    pais VARCHAR(16) NOT NULL,
    -- A janela que a Red Rock DISSE ter apurado. NULL quando ela não informou — e nesse caso é
    -- NULL mesmo, nunca a janela pedida. Preencher com a pedida transformava "a API não disse" em
    -- "a API confirmou o que pedi", e a tela passava a atribuir a ela uma janela que ela nunca
    -- afirmou.
    janela_inicio DATE,
    janela_fim DATE,
    -- A janela que foi PEDIDA. Guardada separada porque as duas divergem de verdade: a consulta de
    -- entregas recorta em 90 dias por padrão, então pedir 124 dias devolve 90 — e a tela precisa
    -- poder mostrar as duas para a diferença não passar despercebida.
    pedido_inicio DATE,
    pedido_fim DATE,
    pedidos INTEGER,
    linhas_cobranca INTEGER,
    frete_total NUMERIC(12,4),
    frete_medio_pedido NUMERIC(12,4),
    sincronizado_em TIMESTAMP DEFAULT NOW()
  );
  -- COALESCE na chave porque janela_inicio/fim agora podem ser NULL, e em índice único NULL não
  -- casa com NULL — duas apurações sem janela informada criariam linhas duplicadas em vez de se
  -- sobrescreverem.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_redrock_frete_janela
    ON produtor_redrock_frete (conta_id, pais,
                               COALESCE(janela_inicio, DATE '0001-01-01'),
                               COALESCE(janela_fim, DATE '0001-01-01'));

  -- Histórico de cada sincronização, inclusive as que falharam.
  --
  -- Existe porque a tela precisa poder dizer "o número é de ontem às 4h" e
  -- "a última tentativa falhou por isto". Sincronização que falha calada é
  -- pior que sincronização que não existe: o painel continua mostrando um
  -- número antigo com cara de número de hoje.
  CREATE TABLE IF NOT EXISTS produtor_redrock_sync (
    id SERIAL PRIMARY KEY,
    conta_id INTEGER NOT NULL REFERENCES produtor_contas(id) ON DELETE CASCADE,
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
  CREATE INDEX IF NOT EXISTS idx_produtor_redrock_sync_conta
    ON produtor_redrock_sync (conta_id, created_at DESC);
`;

/**
 * Migração do modelo antigo (pendurado em clients/kits) para o de conta própria.
 *
 * Roda depois do schema, e só faz alguma coisa se encontrar a forma antiga. A checagem no
 * information_schema é o que mantém isso barato: este arquivo roda a CADA tentativa de reconexão,
 * e um ALTER solto pegaria ACCESS EXCLUSIVE mesmo sem ter o que fazer — travaria as tabelas
 * exatamente quando o banco já está em dificuldade. Com a checagem, o caminho normal é uma leitura
 * de catálogo e nenhum lock.
 *
 * Preserva tudo. Cada client_id que aparecia em alguma tabela do produtor vira uma conta, já
 * ligada àquele cliente pela ponte; cada kit referenciado vira um produto, com o custo unitário
 * que estava em produtor_custo_produto. Só depois de os vínculos novos estarem preenchidos é que
 * as colunas velhas caem.
 *
 * A tabela produtor_custo_produto some: ela era 1 para 1 com o produto (as faturas provaram que o
 * pote custa o mesmo em qualquer embalagem), e uma tabela inteira para guardar duas colunas de um
 * registro que já existe é uma junção a mais em toda consulta, para sempre.
 */
export const PRODUTOR_MIGRACAO_SQL = `
-- ── Reparos de coluna, cada um com a sua própria checagem ────────────────────
--
-- Vivem fora do bloco grande de propósito: um banco pode já estar no modelo de conta e ainda não
-- ter passado por estes. É o caso real de produtor_faturas — a tabela foi criada em produção por
-- um deploy que subiu esta branch num commit antigo, antes de origem/origem_id existirem, e
-- CREATE TABLE IF NOT EXISTS nunca mais as acrescentaria.
--
-- A checagem no information_schema antes do ALTER é o ponto. Um "ADD COLUMN IF NOT EXISTS" solto
-- pega ACCESS EXCLUSIVE mesmo sem ter o que fazer, e este arquivo roda a CADA tentativa de
-- reconexão — travaria as tabelas justamente quando o banco já está em dificuldade.
DO $reparos$
BEGIN
  -- Sempre foi o "Prd ID" da Digistore, nunca a FK do produto local. Com
  -- produtor_ofertas.produto_id ao lado significando outra coisa, escrever
  -- "v.produto_id = o.produto_id" casaria tudo com nada, em silêncio.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'produtor_vendas' AND column_name = 'produto_id') THEN
    ALTER TABLE produtor_vendas RENAME COLUMN produto_id TO gateway_produto_id;
  END IF;

  -- Sem estas duas, a sincronização da Red Rock quebra no INSERT da primeira fatura — e quebra
  -- longe da causa, semanas depois de o deploy que criou a tabela ter parecido bem-sucedido.
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'produtor_faturas')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'produtor_faturas' AND column_name = 'origem') THEN
    ALTER TABLE produtor_faturas
      ADD COLUMN origem VARCHAR(20) NOT NULL DEFAULT 'manual',
      ADD COLUMN origem_id VARCHAR(120);
  END IF;

  -- A janela pedida, ao lado da apurada. Antes existia só uma coluna e ela recebia a pedida quando
  -- a API não informava a sua — o que fazia a tela atribuir à Red Rock uma janela que ela nunca
  -- disse. O NOT NULL das colunas antigas também cai: "não informada" precisa poder ser NULL.
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'produtor_redrock_frete')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'produtor_redrock_frete' AND column_name = 'pedido_inicio') THEN
    ALTER TABLE produtor_redrock_frete
      ADD COLUMN pedido_inicio DATE,
      ADD COLUMN pedido_fim DATE,
      ALTER COLUMN janela_inicio DROP NOT NULL,
      ALTER COLUMN janela_fim DROP NOT NULL;
    -- As linhas que já existem foram gravadas com a janela apurada nas colunas antigas; a pedida
    -- não foi guardada e não dá para inventar. Fica NULL, e a tela sabe dizer "não registrada".
    DROP INDEX IF EXISTS idx_produtor_redrock_frete_janela;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'produtor_fulfillment')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'produtor_fulfillment' AND column_name = 'frete_medido_pedidos') THEN
    ALTER TABLE produtor_fulfillment
      ADD COLUMN frete_medido_pedidos INTEGER,
      ADD COLUMN frete_medido_em TIMESTAMP;
  END IF;
END
$reparos$;

DO $migra$
DECLARE
  antiga BOOLEAN;
  t TEXT;
  -- Todas as tabelas que pendiam do cliente. A migração passa por cada uma e PULA as que não
  -- existirem: ela roda ANTES do resto do schema (que é quem as cria), então um banco parado num
  -- deploy intermediário tem uma parte delas e não a outra. Sem esse cuidado, a migração falharia
  -- em "relation does not exist" e o servidor subiria com o banco marcado como indisponível.
  tabelas TEXT[] := ARRAY[
    'produtor_ofertas', 'produtor_fulfillment', 'produtor_importacoes', 'produtor_vendas',
    'produtor_faturas', 'produtor_credenciais', 'produtor_redrock_pedidos',
    'produtor_redrock_cobrancas', 'produtor_redrock_frete', 'produtor_redrock_sync'
  ];
  removidas BIGINT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'produtor_ofertas' AND column_name = 'client_id'
  ) INTO antiga;

  IF NOT antiga THEN RETURN; END IF;

  RAISE NOTICE 'Produtor: migrando do modelo por cliente para o de conta própria';

  -- 1. Uma conta por cliente que tinha qualquer dado de produtor. O nome vem do cliente, e a
  --    ponte já nasce ligada — era exatamente essa a relação que existia antes.
  FOREACH t IN ARRAY tabelas LOOP
    CONTINUE WHEN to_regclass(t) IS NULL;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_name = t AND column_name = 'client_id');
    EXECUTE format($f$
      INSERT INTO produtor_contas (nome, client_id, moeda)
      SELECT COALESCE(NULLIF(TRIM(c.company_name), ''), 'Conta ' || d.client_id),
             d.client_id,
             COALESCE(c.default_currency, 'USD')
        FROM (SELECT DISTINCT client_id FROM %I WHERE client_id IS NOT NULL) d
        LEFT JOIN clients c ON c.id = d.client_id
       WHERE NOT EXISTS (SELECT 1 FROM produtor_contas pc WHERE pc.client_id = d.client_id)
    $f$, t);
  END LOOP;

  -- 2. Um produto por kit referenciado, levando junto o custo unitário e o nome na fatura.
  IF to_regclass('produtor_custo_produto') IS NOT NULL THEN
    INSERT INTO produtor_produtos (conta_id, nome, kit_id, nome_na_fatura, custo_unidade)
    SELECT pc.id, COALESCE(NULLIF(TRIM(k.name), ''), 'Produto ' || k.id), k.id,
           cp.nome_na_fatura, cp.custo_unidade
      FROM produtor_custo_produto cp
      JOIN produtor_contas pc ON pc.client_id = cp.client_id
      JOIN kits k ON k.id = cp.kit_id
     WHERE NOT EXISTS (SELECT 1 FROM produtor_produtos pp
                        WHERE pp.conta_id = pc.id AND pp.kit_id = k.id);
  END IF;

  -- Kits que aparecem em oferta ou fatura mas não tinham custo cadastrado entram sem custo — que
  -- é a verdade sobre eles, e a tela sabe mostrar "não cadastrado" em vez de zero.
  INSERT INTO produtor_produtos (conta_id, nome, kit_id)
  SELECT DISTINCT pc.id, COALESCE(NULLIF(TRIM(k.name), ''), 'Produto ' || k.id), k.id
    FROM (
      SELECT client_id, kit_id FROM produtor_ofertas WHERE kit_id IS NOT NULL
      UNION SELECT client_id, kit_id FROM produtor_faturas WHERE kit_id IS NOT NULL
    ) d
    JOIN produtor_contas pc ON pc.client_id = d.client_id
    JOIN kits k ON k.id = d.kit_id
   WHERE NOT EXISTS (SELECT 1 FROM produtor_produtos pp
                      WHERE pp.conta_id = pc.id AND pp.kit_id = k.id);

  -- 3. Cada tabela troca client_id por conta_id. Uma de cada vez, e só as que existem.
  FOREACH t IN ARRAY tabelas LOOP
    CONTINUE WHEN to_regclass(t) IS NULL;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_name = t AND column_name = 'client_id');

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS conta_id INTEGER', t);
    EXECUTE format('UPDATE %I x SET conta_id = pc.id FROM produtor_contas pc WHERE pc.client_id = x.client_id', t);

    -- produto_id, para as duas tabelas que apontavam para um kit. Antes do DROP, que é quando
    -- kit_id ainda existe para servir de ponte.
    IF t IN ('produtor_ofertas', 'produtor_faturas') THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS produto_id INTEGER', t);
      EXECUTE format('UPDATE %I x SET produto_id = pp.id FROM produtor_produtos pp
                       WHERE pp.conta_id = x.conta_id AND pp.kit_id = x.kit_id', t);
    END IF;

    -- Linha sem conta é linha cujo cliente já não existe: ela estava inalcançável pela tela antes
    -- desta migração. Sai, e o RAISE deixa o rastro no log — apagar calado seria pior que não migrar.
    EXECUTE format('DELETE FROM %I WHERE conta_id IS NULL', t);
    GET DIAGNOSTICS removidas = ROW_COUNT;
    IF removidas > 0 THEN
      RAISE NOTICE 'Produtor: % linha(s) órfã(s) removidas de %', removidas, t;
    END IF;

    IF t = 'produtor_ofertas' THEN
      EXECUTE 'DELETE FROM produtor_ofertas WHERE produto_id IS NULL';
      GET DIAGNOSTICS removidas = ROW_COUNT;
      IF removidas > 0 THEN
        RAISE NOTICE 'Produtor: % oferta(s) sem produto removidas', removidas;
      END IF;
    END IF;

    EXECUTE format('ALTER TABLE %I DROP COLUMN client_id', t);
    IF t IN ('produtor_ofertas', 'produtor_faturas') THEN
      EXECUTE format('ALTER TABLE %I DROP COLUMN kit_id', t);
    END IF;

    EXECUTE format('ALTER TABLE %I ALTER COLUMN conta_id SET NOT NULL', t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (conta_id)
                      REFERENCES produtor_contas(id) ON DELETE CASCADE', t, t || '_conta_fk');
  END LOOP;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'produtor_ofertas' AND column_name = 'produto_id') THEN
    ALTER TABLE produtor_ofertas ALTER COLUMN produto_id SET NOT NULL;
    ALTER TABLE produtor_ofertas ADD CONSTRAINT produtor_ofertas_produto_fk
      FOREIGN KEY (produto_id) REFERENCES produtor_produtos(id) ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'produtor_faturas' AND column_name = 'produto_id') THEN
    ALTER TABLE produtor_faturas ADD CONSTRAINT produtor_faturas_produto_fk
      FOREIGN KEY (produto_id) REFERENCES produtor_produtos(id) ON DELETE SET NULL;
  END IF;

  DROP TABLE IF EXISTS produtor_custo_produto;

  -- 4. Índices que o CREATE do schema não pôde criar porque a tabela já existia. Todos
  --    IF NOT EXISTS, e só para as tabelas que estão aqui.
  IF to_regclass('produtor_ofertas') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_produtor_ofertas_produto ON produtor_ofertas (conta_id, produto_id);
  END IF;
  IF to_regclass('produtor_fulfillment') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_fulfillment_conta ON produtor_fulfillment (conta_id);
  END IF;
  IF to_regclass('produtor_vendas') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_vendas_transacao
      ON produtor_vendas (conta_id, transacao_id, COALESCE(gateway_produto_id, ''));
    CREATE INDEX IF NOT EXISTS idx_produtor_vendas_data ON produtor_vendas (conta_id, data);
  END IF;
  IF to_regclass('produtor_faturas') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_produtor_faturas_produto
      ON produtor_faturas (conta_id, produto_id, competencia_inicio, competencia_fim);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_faturas_numero
      ON produtor_faturas (conta_id, LOWER(fornecedor), numero) WHERE numero IS NOT NULL;
  END IF;
  IF to_regclass('produtor_credenciais') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_credenciais_provedor
      ON produtor_credenciais (conta_id, provedor);
  END IF;
  IF to_regclass('produtor_redrock_pedidos') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_redrock_pedidos_ext
      ON produtor_redrock_pedidos (conta_id, external_order_id);
    CREATE INDEX IF NOT EXISTS idx_produtor_redrock_pedidos_data
      ON produtor_redrock_pedidos (conta_id, criado_em);
  END IF;
  IF to_regclass('produtor_redrock_cobrancas') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_redrock_cobrancas_linha
      ON produtor_redrock_cobrancas (conta_id, external_order_id, linha);
    CREATE INDEX IF NOT EXISTS idx_produtor_redrock_cobrancas_fatura
      ON produtor_redrock_cobrancas (conta_id, numero_fatura);
    CREATE INDEX IF NOT EXISTS idx_produtor_redrock_cobrancas_data
      ON produtor_redrock_cobrancas (conta_id, data);
  END IF;
  IF to_regclass('produtor_redrock_frete') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_produtor_redrock_frete_janela
      ON produtor_redrock_frete (conta_id, pais, janela_inicio, janela_fim);
  END IF;
  IF to_regclass('produtor_redrock_sync') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_produtor_redrock_sync_conta
      ON produtor_redrock_sync (conta_id, created_at DESC);
  END IF;
END
$migra$;
`;
