/**
 * Invariantes do painel — as contas que TÊM que fechar, sempre.
 *
 * Por que existe: em um único dia foram encontrados três bugs de número em produção, todos da
 * MESMA forma — somar dois conjuntos que se sobrepõem:
 *
 *   1. Leads consolidados: 39.173 (SMS) + 38.672 (AC) = 77.845 pessoas numa base que não tem 77
 *      mil pessoas. A mesma pessoa está na lista e na tag.
 *   2. Conversão por segmento: "Compradores" contava TODAS as vendas do canal, inclusive as de
 *      carrinho abandonado. 21 + 28 = 49 numa tela que dizia 28 vendas no período.
 *   3. Nota de reconciliação: "70 vendas e 52 recuperações" com as 52 dentro das 70.
 *
 * Os três passaram meses na tela sem ninguém notar, porque número errado parece exatamente igual
 * a número certo. Nenhum foi encontrado por teste — foram encontrados porque alguém estranhou.
 *
 * A ideia aqui: em vez de confiar que ninguém erra, o servidor confere as identidades a cada
 * resposta e a tela DIZ quando alguma não fecha. Mostrar inconsistência ao usuário parece
 * agressivo, e é de propósito: a alternativa é o painel exibir 31,1% de conversão por meses e
 * todo mundo acreditar.
 *
 * LIMITE HONESTO: invariante só pega erro de aritmética interna. Não pega venda atribuída ao
 * canal errado, nem número errado vindo da API da SlickText — para isso continua valendo comparar
 * contra o painel deles. E cada identidade é escrita à mão: isto é uma lista que cresce conforme
 * se entende o que tem que fechar, não uma verificação automática de tudo.
 */

export interface Invariante {
  nome: string;
  /** O que a identidade afirma, em português, para quem lê o diagnóstico sem abrir o código. */
  afirma: string;
  esquerda: number | null;
  direita: number | null;
  fecha: boolean | null;
  /** Diferença absoluta quando não fecha — é o que diz o tamanho do estrago. */
  diferenca: number | null;
  /** Por que o número que quebrou importa: o que a pessoa concluiria errado olhando a tela. */
  consequencia?: string;
}

/**
 * Compara dois lados. Tolerância zero para contagens (venda é inteiro, não arredonda) e um
 * centavo para dinheiro, porque somar NUMERIC(12,2) em ordens diferentes pode diferir na última
 * casa sem que nada esteja errado.
 */
function conferir(
  nome: string,
  afirma: string,
  esquerda: number | null | undefined,
  direita: number | null | undefined,
  opts: { tolerancia?: number; consequencia?: string } = {}
): Invariante {
  const e = esquerda ?? null;
  const d = direita ?? null;

  // Faltar um dos lados NÃO é invariante quebrada — é invariante não verificável. Tratar como
  // falha geraria alarme falso toda vez que a SlickText não respondesse, e alarme falso ensina a
  // ignorar o alarme verdadeiro.
  if (e === null || d === null) {
    return { nome, afirma, esquerda: e, direita: d, fecha: null, diferenca: null, consequencia: opts.consequencia };
  }

  const diferenca = Math.abs(e - d);
  return {
    nome,
    afirma,
    esquerda: e,
    direita: d,
    fecha: diferenca <= (opts.tolerancia ?? 0),
    diferenca: parseFloat(diferenca.toFixed(2)),
    consequencia: opts.consequencia,
  };
}

export interface EntradaSegmento {
  recuperacoes: number | null;
  compradores: number | null;
  naoClassificado: number | null;
  totalCanal: number | null;
}

export interface EntradaEscopo {
  dentroRec: number | null;
  dentroCompra: number | null;
  foraRec: number | null;
  foraCompra: number | null;
  /** Entra na identidade porque dentro+fora só cobre o que FOI classificado. */
  naoClassificado: number | null;
  totalCanal: number | null;
}

export interface EntradaMensagens {
  somaDasMensagens: number | null;
  receitaLiquidaCanal: number | null;
}

export interface EntradaCanais {
  faturamentoSms: number | null;
  faturamentoEmail: number | null;
  faturamentoTotalCliente: number | null;
}

export function conferirInvariantes(entradas: {
  segmentoSms?: EntradaSegmento;
  escopoSms?: EntradaEscopo;
  mensagensSms?: EntradaMensagens;
  canais?: EntradaCanais;
}): { invariantes: Invariante[]; quebradas: Invariante[]; tudoFecha: boolean } {
  const lista: Invariante[] = [];

  if (entradas.segmentoSms) {
    const s = entradas.segmentoSms;
    lista.push(conferir(
      'segmentos_particionam_o_canal',
      'recuperações + compradores + não classificado = total de vendas do canal',
      (s.recuperacoes ?? 0) + (s.compradores ?? 0) + (s.naoClassificado ?? 0),
      s.totalCanal,
      {
        consequencia:
          'Se não fecha, alguma venda está em dois segmentos ao mesmo tempo (a taxa daquele segmento sai maior do que é) ou em nenhum (a taxa sai menor). Foi exatamente este o bug de 08/08/2026: "Compradores" contava todas as vendas do canal.',
      }
    ));
  }

  if (entradas.escopoSms) {
    const e = entradas.escopoSms;
    lista.push(conferir(
      'dentro_mais_fora_do_escopo',
      'vendas dentro do escopo + fora do escopo + não classificadas = total de vendas do canal',
      (e.dentroRec ?? 0) + (e.dentroCompra ?? 0) + (e.foraRec ?? 0) + (e.foraCompra ?? 0) + (e.naoClassificado ?? 0),
      e.totalCanal,
      {
        consequencia:
          'Se não fecha, a nota de reconciliação ("X vendas não aparecem nesta tabela") está mentindo sobre quantas ficaram de fora — e quem lê acha que o buraco é menor do que é.',
      }
    ));
  }

  if (entradas.mensagensSms) {
    const m = entradas.mensagensSms;
    lista.push(conferir(
      'mensagens_somam_a_receita_do_canal',
      'soma da receita de todas as mensagens = receita líquida do canal',
      m.somaDasMensagens,
      m.receitaLiquidaCanal,
      {
        tolerancia: 0.01,
        consequencia:
          'Se não fecha, existe receita atribuída ao canal que não pertence a mensagem nenhuma (ou o contrário), e as porcentagens de "% do total" da tabela ficam todas erradas.',
      }
    ));
  }

  if (entradas.canais) {
    const c = entradas.canais;
    // ESTA É DESIGUALDADE, não igualdade: existe venda que não é nem SMS nem email (tráfego de
    // afiliado, Taboola, direto). Se um dia a soma dos dois canais PASSAR do total do cliente,
    // alguma venda está sendo contada nos dois — que é o mesmo erro de sobreposição, uma camada
    // acima. Escrito como igualdade seria alarme falso todo dia.
    const soma = (c.faturamentoSms ?? 0) + (c.faturamentoEmail ?? 0);
    const total = c.faturamentoTotalCliente;
    lista.push({
      nome: 'canais_nao_passam_do_total',
      afirma: 'faturamento SMS + Email ≤ faturamento total do cliente (existe venda que não é de nenhum dos dois)',
      esquerda: soma,
      direita: total,
      fecha: total === null ? null : soma <= total + 0.01,
      diferenca: total === null ? null : parseFloat(Math.max(0, soma - total).toFixed(2)),
      consequencia:
        'Se a soma passa do total, a mesma venda está sendo contada em dois canais — e o faturamento atribuído à MailX fica maior do que o que o cliente realmente faturou.',
    });
  }

  const quebradas = lista.filter((i) => i.fecha === false);
  return { invariantes: lista, quebradas, tudoFecha: quebradas.length === 0 };
}
