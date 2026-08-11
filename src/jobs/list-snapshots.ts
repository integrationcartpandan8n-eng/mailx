/**
 * Retrato diário das listas da SlickText — gravação automática.
 *
 * Por que existe: leads por período são a diferença entre dois retratos do tamanho de cada lista, e
 * a API da SlickText não conta contatos de uma lista dentro de um período. Até aqui o retrato era
 * gravado de carona, quando alguém abria a aba SMS de um cliente — o que deixava a série com
 * buracos: no cliente de referência havia 5 retratos em 8 dias, e por isso qualquer recorte de 30
 * dias caía no total vitalício, e recortes curtos caíam na tolerância de 3 dias com a janela de
 * leads maior que a das vendas.
 *
 * Um dia sem retrato é perdido para sempre: não existe como recuperar retroativamente quantos
 * contatos uma lista tinha ontem. Por isso a gravação passa a ser do servidor, e não do visitante.
 *
 * Como roda: verifica de meia em meia hora se o retrato de HOJE já existe, e grava o que faltar.
 * Não é um horário fixo de propósito — com horário fixo, um restart ou uma indisponibilidade da
 * SlickText naquele minuto exato custaria o dia inteiro. Verificando com frequência, o dia é
 * gravado na primeira janela em que der, e as verificações seguintes não fazem nada.
 */
import { query } from '../db/database';
import { SlickTextClient } from '../services/slicktext';
import { logger } from '../utils/logger';

const CTX = 'RetratoListas';
const INTERVALO_MS = 30 * 60 * 1000;
const ATRASO_INICIAL_MS = 60 * 1000; // deixa o servidor subir antes de sair consultando API externa

type ContaSt = { clientId: number; accountId: number | null; token: string; brandId: string };

async function contasComSlickText(): Promise<ContaSt[]> {
  const principais = await query<{ id: number; st_api_token: string; st_brand_id: string }>(
    `SELECT id, st_api_token, st_brand_id FROM clients
     WHERE st_api_token IS NOT NULL AND st_brand_id IS NOT NULL AND status <> 'paused'`
  );
  const extras = await query<{ client_id: number; id: number; st_api_token: string; st_brand_id: string }>(
    `SELECT a.client_id, a.id, a.st_api_token, a.st_brand_id
     FROM client_slicktext_accounts a
     JOIN clients c ON c.id = a.client_id
     WHERE c.status <> 'paused'`
  );
  return [
    ...principais.map(c => ({ clientId: c.id, accountId: null, token: c.st_api_token, brandId: c.st_brand_id })),
    ...extras.map(a => ({ clientId: a.client_id, accountId: a.id, token: a.st_api_token, brandId: a.st_brand_id })),
  ];
}

/**
 * Grava o retrato de hoje das listas que ainda não têm. Devolve quantas listas foram gravadas.
 *
 * Uma lista é contada em TODAS as contas do cliente e vale o MAIOR valor: um list_id existe em uma
 * conta só, e nas outras a chamada falha e devolve 0 — somar contaria a mesma lista de novo se duas
 * respondessem, e usar a primeira resposta gravaria 0 quando a conta errada respondesse primeiro.
 */
export async function gravarRetratosDeHoje(): Promise<{ gravadas: number; jaTinham: number; falhas: number }> {
  const resultado = { gravadas: 0, jaTinham: 0, falhas: 0 };

  // TODAS as listas de TODAS as contas, não só as vinculadas a um produto.
  //
  // Antes o retrato só cobria lista vinculada, e isso criou um ponto cego que custou caro: em
  // 10/08/2026 a lista de compradores do NeuroMind apareceu congelada em 19.706 por 11 dias. A
  // causa era que o fluxo tinha migrado para outra conta da SlickText, onde existe uma lista
  // homônima com 20.095 contatos — que o painel nunca olhou porque ninguém a vinculou.
  //
  // Ou seja: exatamente a lista que responderia "qual está viva?" era a que não tinha retrato. E
  // sem série histórica não há como decidir por medição — só por chute pelo tamanho, que é o que
  // esta função existe para evitar. Contar lista não vinculada é barato (uma requisição por lista,
  // uma vez por dia) e é o que permite descobrir a migração sozinho na próxima vez.
  const vinculadas = await query<{ client_id: number; list_id: string }>(
    `SELECT DISTINCT k.client_id, x.list_id
     FROM kits k
     CROSS JOIN LATERAL (VALUES (k.st_list_compra_id), (k.st_list_abandono_id)) AS x(list_id)
     JOIN clients c ON c.id = k.client_id
     WHERE k.enabled = true AND x.list_id IS NOT NULL AND c.status <> 'paused'`
  );

  // O inventário vem da própria SlickText, conta por conta. Falha em uma conta não impede as
  // outras: metade dos retratos é melhor que nenhum, e a falha aparece no contador.
  const contas = await contasComSlickText();
  const inventario: { client_id: number; list_id: string }[] = [];
  // Dono conhecido de cada lista. Listar já diz em qual conta a lista está, e isso dispensa
  // perguntar o tamanho dela nas outras contas do cliente — com três contas, sondar todas seria
  // três vezes mais requisição para dois erros esperados e uma resposta.
  const contaDaLista = new Map<string, number | null>();
  // Nome por lista, para o retrato dizer o que é sem precisar de outra chamada depois.
  const nomeDaLista = new Map<string, string>();
  for (const conta of contas) {
    try {
      const st = new SlickTextClient(conta.token, conta.brandId);
      for (const l of await st.getLists()) {
        const id = String(l.contact_list_id);
        inventario.push({ client_id: conta.clientId, list_id: id });
        const chave = `${conta.clientId}:${id}`;
        if (!contaDaLista.has(chave)) contaDaLista.set(chave, conta.accountId);
        if (l.name && !nomeDaLista.has(chave)) nomeDaLista.set(chave, String(l.name).slice(0, 255));
      }
    } catch (err: any) {
      logger.warn(CTX, `Não consegui listar as listas da conta ${conta.brandId}: ${err.message}`);
      resultado.falhas++;
    }
  }

  // Dedup por cliente+lista, e NÃO por cliente+conta+lista: quem lê os retratos consulta só
  // client_id e list_id (ver leadsPorPeriodoViaSnapshots), então gravar a mesma lista duas vezes
  // sob contas diferentes deixaria a leitura escolhendo uma das duas por ordem de data.
  const vistas = new Set<string>();
  const listas = [...vinculadas, ...inventario].filter(l => {
    const k = `${l.client_id}:${l.list_id}`;
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
  if (listas.length === 0) return resultado;

  // O que já tem retrato de hoje sai da fila antes de qualquer chamada externa: numa segunda
  // passada do dia isso zera o trabalho e não gasta uma requisição sequer.
  const jaGravadas = await query<{ client_id: number; list_id: string }>(
    `SELECT DISTINCT client_id, list_id FROM list_contact_snapshots WHERE snapshot_date = CURRENT_DATE`
  );
  const jaTem = new Set(jaGravadas.map(r => `${r.client_id}:${r.list_id}`));
  const pendentes = listas.filter(l => !jaTem.has(`${l.client_id}:${l.list_id}`));
  resultado.jaTinham = listas.length - pendentes.length;
  if (pendentes.length === 0) return resultado;

  const porCliente = new Map<number, ContaSt[]>();
  for (const c of contas) {
    const arr = porCliente.get(c.clientId) ?? [];
    arr.push(c);
    porCliente.set(c.clientId, arr);
  }

  for (const lista of pendentes) {
    const todasDoCliente = porCliente.get(lista.client_id);
    if (!todasDoCliente || todasDoCliente.length === 0) continue;

    // Se o inventário disse de qual conta a lista é, pergunta só a ela. Só cai na sondagem de
    // todas quando a lista vem de kit e não apareceu em listagem nenhuma — caso em que não se
    // sabe o dono e não perguntar significaria perder o retrato do dia.
    const chave = `${lista.client_id}:${lista.list_id}`;
    const dono = contaDaLista.has(chave)
      ? todasDoCliente.filter(c => c.accountId === contaDaLista.get(chave))
      : [];
    const doCliente = dono.length > 0 ? dono : todasDoCliente;

    let melhor = { count: 0, accountId: null as number | null };
    for (const conta of doCliente) {
      try {
        const st = new SlickTextClient(conta.token, conta.brandId);
        const count = await st.getListContactCount(parseInt(lista.list_id));
        // null = falha real (não "esta conta não tem essa lista", que já é o catch abaixo) —
        // não pode virar candidato a "melhor" nem disputar com uma conta que respondeu de verdade.
        if (count != null && count > melhor.count) melhor = { count, accountId: conta.accountId };
      } catch {
        // Conta que não tem essa lista responde erro — esperado, não é falha do job.
      }
    }

    // Zero não é gravado: pode ser lista realmente vazia ou nenhuma conta ter respondido, e as duas
    // são indistinguíveis daqui. Gravar 0 criaria um degrau falso na diferença entre dois dias — a
    // lista pareceria ter perdido todos os contatos e ganhado de volta no dia seguinte.
    if (melhor.count <= 0) {
      resultado.falhas++;
      continue;
    }

    try {
      await query(
        // COALESCE no nome ao atualizar: se a segunda passada do dia não souber o nome (lista de
        // kit que não apareceu em listagem nenhuma), não apaga o que a primeira já tinha gravado.
        `INSERT INTO list_contact_snapshots (client_id, st_account_id, list_id, snapshot_date, contact_count, list_name)
         VALUES ($1, $2, $3, CURRENT_DATE, $4, $5)
         ON CONFLICT (client_id, COALESCE(st_account_id, 0), list_id, snapshot_date)
         DO UPDATE SET contact_count = EXCLUDED.contact_count,
                       list_name = COALESCE(EXCLUDED.list_name, list_contact_snapshots.list_name)`,
        [lista.client_id, melhor.accountId, lista.list_id, melhor.count, nomeDaLista.get(chave) ?? null]
      );
      resultado.gravadas++;
    } catch (err: any) {
      logger.warn(CTX, `Falha ao gravar retrato da lista ${lista.list_id} (cliente ${lista.client_id}): ${err.message}`);
      resultado.falhas++;
    }
  }

  return resultado;
}

export function startListSnapshotJob(): void {
  // A PRIMEIRA execução depois de subir sempre escreve no log, mesmo sem nada a fazer.
  //
  // Antes só logava quando gravava ou falhava, e o resultado foi ficar sem saber se o job tinha
  // rodado: com todas as listas já em dia ele ficava calado, e silêncio significava as duas coisas
  // ao mesmo tempo — "não havia nada a gravar" e "o corpo nunca executou". Num job que roda sozinho,
  // sem ninguém olhando, essas duas precisam ser distinguíveis.
  //
  // As execuções seguintes continuam caladas quando não há nada a fazer: 48 linhas por dia dizendo
  // "nada a fazer" treinaria qualquer um a ignorar o log deste job, que é onde a falha vai aparecer.
  let primeiraExecucao = true;
  const rodar = async () => {
    try {
      const r = await gravarRetratosDeHoje();
      const total = r.gravadas + r.jaTinham + r.falhas;
      if (r.gravadas > 0 || r.falhas > 0 || primeiraExecucao) {
        logger.info(
          CTX,
          `Retratos de hoje: ${r.gravadas} gravadas, ${r.jaTinham} já tinham, ${r.falhas} sem contagem ` +
          `(${total} lista(s) ativa(s))${primeiraExecucao ? ' — primeira verificação após subir' : ''}`
        );
      }
      primeiraExecucao = false;
    } catch (err: any) {
      primeiraExecucao = false;
      // Nunca derruba o servidor: o retrato é para o relatório de amanhã, não para a requisição de
      // agora. Falhar em silêncio ruidoso (log) é melhor que matar o processo.
      logger.error(CTX, `Job de retratos falhou: ${err.message}`);
    }
  };

  setTimeout(rodar, ATRASO_INICIAL_MS);
  setInterval(rodar, INTERVALO_MS).unref();
  logger.info(CTX, `Gravação automática de retratos ligada (verifica a cada ${INTERVALO_MS / 60000} min)`);
}
