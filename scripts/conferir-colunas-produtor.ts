/**
 * Confere se um banco criado por uma versão ANTIGA do schema chega, depois do deploy de hoje, com
 * todas as colunas que o código espera.
 *
 * Por que existe: CREATE TABLE IF NOT EXISTS nunca acrescenta coluna. Um banco que criou a tabela
 * numa versão antiga fica sem ela para sempre, e a falha aparece longe da causa — num INSERT,
 * semanas depois, com "column X of relation Y does not exist" numa tela que não fala de schema.
 * Aconteceu três vezes: produtor_faturas.origem, produtor_vendas.gateway_produto_id e
 * produtor_vendas.valor_liquido, esta última já com o usuário na frente da tela.
 *
 * Como usar: precisa de um Postgres descartável (NÃO aponte para produção — o script cria e
 * derruba bancos). Compile os schemas antigos que já foram para produção e rode:
 *
 *   for C in <commits>; do
 *     git show $C:src/produtor/schema.ts > /tmp/s_$C.ts
 *     npx tsc /tmp/s_$C.ts --outDir /tmp --module commonjs --target ES2022
 *     mv /tmp/s_$C.js /tmp/sc_$C.js
 *   done
 *   npm run build
 *   npx tsx scripts/conferir-colunas-produtor.ts
 *
 * Quando acusar coluna faltando, acrescente uma linha na lista `novas` do bloco de reparos em
 * src/produtor/schema.ts. É ela a memória do que os bancos antigos não têm.
 */
const Pg = require('/home/user/mailx/node_modules/pg');
const COMMITS = ['31d0ea3', '292f6db', '43ae8ac'];
(async () => {
  const adm = new Pg.Pool({ connectionString: 'postgresql://mailx@/postgres?host=/var/tmp&port=5433' });
  const colunasDe = async (db: string, aplicar: (p: any) => Promise<void>) => {
    await adm.query(`DROP DATABASE IF EXISTS ${db}`);
    await adm.query(`CREATE DATABASE ${db}`);
    const p = new Pg.Pool({ connectionString: `postgresql://mailx@/${db}?host=/var/tmp&port=5433` });
    await p.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, company_name VARCHAR(255) NOT NULL,
      contact_email VARCHAR(255), default_currency VARCHAR(3) DEFAULT 'USD', status VARCHAR(40))`);
    await p.query(`CREATE TABLE kits (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id),
      name VARCHAR(255), slug VARCHAR(255), external_id VARCHAR(120), platform VARCHAR(40), enabled BOOLEAN DEFAULT true)`);
    await aplicar(p);
    const r = await p.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name LIKE 'produtor_%' ORDER BY 1,2`);
    await p.end();
    const m = new Map<string, Set<string>>();
    for (const row of r.rows) {
      if (!m.has(row.table_name)) m.set(row.table_name, new Set());
      m.get(row.table_name)!.add(row.column_name);
    }
    return m;
  };

  const hoje = await colunasDe('cmp_hoje', async (p) => {
    const s = require('/home/user/mailx/dist/produtor/schema.js');
    await p.query(s.PRODUTOR_BASE_SQL); await p.query(s.PRODUTOR_MIGRACAO_SQL); await p.query(s.PRODUTOR_SCHEMA_SQL);
  });

  for (const c of COMMITS) {
    let antigo;
    try {
      antigo = await colunasDe(`cmp_${c}`, async (p) => {
        await p.query(require(`/tmp/sc_${c}.js`).PRODUTOR_SCHEMA_SQL);
        // e entao o deploy de hoje por cima
        const s = require('/home/user/mailx/dist/produtor/schema.js');
        await p.query(s.PRODUTOR_BASE_SQL); await p.query(s.PRODUTOR_MIGRACAO_SQL); await p.query(s.PRODUTOR_SCHEMA_SQL);
      });
    } catch (e: any) { console.log(`${c}: ERRO — ${e.message}`); continue; }

    const faltando: string[] = [];
    for (const [t, cols] of hoje) {
      const a = antigo.get(t);
      if (!a) { faltando.push(`${t} (tabela inteira)`); continue; }
      for (const col of cols) if (!a.has(col)) faltando.push(`${t}.${col}`);
    }
    console.log(`\nbanco criado em ${c}, depois deployado para hoje:`);
    console.log(faltando.length ? '  FALTAM: ' + faltando.join(', ') : '  nenhuma coluna faltando');
  }
  await adm.end();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
