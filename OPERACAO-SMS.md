# Operação SMS — o que a dash mede, como conferir e o que não dá

Documento prático do canal SMS (SlickText). Serve para (a) saber de onde vem cada número da tela,
(b) conferir a dash contra o painel sem repetir os enganos que já custaram tempo, e (c) reconhecer
os limites da plataforma antes de tratá-los como bug.

Validado em 01–29/07/2026 no cliente 4 (duas contas: `Principal`/brand 27972 e `Conta 30`/brand 30571).

---

## 1. Quem faz o quê

A **SlickText é o canal**: tem os números, o contrato com as carriers e os créditos. Nenhum SMS sai
de um servidor nosso.

A **MailX é o remetente**: o workflow, a segmentação (quem entra na lista vem do webhook da
Digistore que a gente processa), o texto e o link rastreado com `utm_campaign` são nossos. A
SlickText não decide quando nem para quem enviar — executa o gatilho que o fluxo MailX definiu.

Por isso a coluna "envios" da tela não é uma afirmação de que operamos a carrier: é a contagem de
mensagens **daquela automação nossa**, lida da SlickText porque ela é a fonte da verdade de entrega.
É o que torna `envios/venda` e `cliques/venda` comparáveis — numerador e denominador do mesmo disparo.

---

## 2. De onde vem cada número

| Indicador na tela | Fonte | Escopo | Observação |
| --- | --- | --- | --- |
| Envios por mensagem | paginação de `GET /messages` com `_sub_source_id` (busca binária por data) | **período** | contagem real, registro por registro |
| Envios por mensagem (sem período) | `totals.messages` de `/analytics/workflows/{id}/nodes/{node}` | **vitalício** | o endpoint de node **ignora** `start`/`end` |
| Envios do fluxo inteiro | `/analytics/messages?source=Workflow&_source_id=` | **período** | esse sim filtra por data |
| Cliques por mensagem | `/analytics/links/clicks?group=_link_id`, somando os links daquele `utm_campaign` | **período** | funciona porque o link carrega o utm na URL |
| Cliques de link manual (N8N) | campo `clicks` do próprio registro do link | **vitalício** | não existe versão por período |
| Contatos por lista | `GET /lists/{id}/contacts/count` | **vitalício** | `/analytics/contacts` **ignora** `list_id` |
| Créditos consumidos | `message_credits` de cada mensagem, somado | **período** | ver secção 4 |
| Saldo de crédito | `GET /usage` | atual | |
| Vendas e receita | nosso `webhook_logs`, filtrado por UTM | **período** | não vem da SlickText |

Regra de leitura: **todo número da tela é rotulado como período ou vitalício.** Onde não houver
rótulo, é bug — não assuma.

---

## 3. O padrão de UTM que faz a atribuição funcionar

```
utm_source=mailx-sms
utm_medium=auto-sms
utm_campaign=MS0001A          ← identifica a mensagem (é a chave do vínculo)
utm_content=<oferta>
utm_term=<Produto-CaminhoA|B|C>
```

A tabela por mensagem exige **igualdade exata** em `utm_source` e `utm_medium`, e descarta
`utm_campaign` contendo "teste". O card de faturamento é mais frouxo (`ILIKE '%mailx%'`). Por isso os
dois podem discordar — e essa discordância é medida em `/diagnostico/sms`, não escondida.

ClickBank e Buygoods **não têm UTM**: mandam `tid=` e `subid=`, que caem em
`webhook_logs.tracking_code`. A atribuição já lê essa coluna.

---

## 4. Crédito não é envio

**Uma mensagem acima de 160 caracteres é cobrada por trecho.** Medido no painel da marca 30571 em
01–29/07: **13.081 envios consumiram 39.215 créditos — 3,0 créditos por envio.**

Tratar 1:1 subestima o custo em três vezes. O card "Créditos por Automação" usa o `message_credits`
real quando a fatia pode ser varrida; quando não pode, calibra pela razão medida na amostra e diz
que é estimativa; e sem amostra nenhuma **não estima** — mostra envios e avisa que crédito não foi
medido.

### Rotina que não pode falhar

Fluxo ativo cujo crédito acaba **para de enviar sem erro nenhum**. Do nosso lado isso aparece apenas
como uma queda de envios — indistinguível de queda de demanda.

Confira o saldo em `/diagnostico/cobertura-automacao`, que traz `dias_de_folga_estimados` pelo
consumo do período. Abaixo de 5.000 créditos ele estampa aviso.

---

## 5. Como conferir contra o painel (e o engano a evitar)

O painel só agrega **por marca**. Caminho: `Analytics → Workflows`, `Custom Range`, datas em formato
americano (`07/01/2026` = 1º de julho).

Compare o gráfico **"Workflow Messages Sent"** com `envios_automacao_da_marca_no_periodo` do
`/diagnostico/cobertura-automacao`.

> **Antes de acusar divergência, confirme de qual brand a tela é.** As duas contas do cliente têm
> volumes parecidos. Comparar o 38.191 da 27972 com o 13.081 da 30571 produz uma razão de 2,9× que
> parece indicar que a API conta trechos em vez de mensagens — e não indica nada. A URL tem o brand
> (`app.slicktext.com/b30571/...`).

Diferença de 1–2% é **fuso horário**: o painel fecha o dia em Nova York, a dash em UTC. Não é erro.

A listagem de workflows mostra `—` na coluna Clicks mesmo em fluxos que têm cliques. **Não é zero** —
aquela listagem não serve de fonte de comparação.

---

## 6. O que não tem como fazer

Limitações da SlickText, confirmadas por sonda contra a API real e contra o painel. Não são
pendências.

| Não dá | Por quê |
| --- | --- |
| Conferir envios **por mensagem** contra o painel | o painel não quebra por mensagem, só por marca |
| Envios por mensagem filtrados por data via analytics | `/analytics/workflows/{id}/nodes/{node}` ignora `start`/`end`; contornado com paginação do `/messages` |
| Cliques por período de link manual (N8N) | `/analytics/links/clicks` não vê `source='manual'`; `/links/{id}/clicks`, `/stats` e `/analytics` dão 404 |
| Envios por mensagem de link manual | não existem — links manuais não pertencem a um node |
| Contatos por lista com filtro de período | `/analytics/contacts` ignora `list_id`; só existe o total vitalício |
| Separar mensagem de crédito no analytics agregado | `totals` só tem `total` e `average`, sem campo de crédito |

---

## 7. Diagnósticos

Todos aceitam `?from=YYYY-MM-DD&to=YYYY-MM-DD`.

| Endpoint | Para que |
| --- | --- |
| `/clientes/:id/diagnostico/cobertura-automacao` | quanto da automação da conta está vinculada, + saldo de crédito e dias de folga |
| `/clientes/:id/diagnostico/sms` | por que o card e a tabela discordam, caso por caso com o motivo |
| `/clientes/:id/diagnostico/validacao-sms` | folha de conferência: onde olhar no painel para cada mensagem |
| `/clientes/:id/diagnostico/vinculos` | saúde da configuração, os dois canais, todas as contas |
| `/clientes/:id/diagnostico/probe-envios` | a unidade do analytics é mensagem ou crédito (já respondido: mensagem) |
| `/diagnostico/utms` | inventário de UTM do sistema |
| `/diagnostico/sem-utm` | vendas sem atribuição e por quê |

---

## 8. Estados da tela e o que significam

| Estado | Significado | O que fazer |
| --- | --- | --- |
| número + `envios no período` | contagem real do período | nada |
| `envios (vitalício)` | sem período ativo, ou a contagem por período falhou | selecione um período; se persistir, veja o log |
| âmbar + `tentar de novo` | a SlickText não respondeu (instabilidade) | clicar; duas tentativas já são automáticas |
| `⚠ envios n/d` | link manual (N8N) — envio por mensagem não existe | nada, é definitivo |
| `créditos não medidos` | fatia grande demais para somar o crédito real | o número exibido são **envios**, não créditos |
| `+ N venda(s) SMS fora desta tabela` | vendas no card que a tabela exclui | abrir `/diagnostico/sms` para ver o motivo |

`null` nunca é renderizado como `0`. Ausência de dado e zero são coisas diferentes na tela.

---

## 9. Estado da validação — 01–29/07/2026, cliente 4

| Checagem | Resultado |
| --- | --- |
| Total de automação × painel (brand 30571) | 13.116 × 13.081 — **0,27%** (fuso) |
| Cobertura dos vínculos — Principal | **100%** (7 fluxos, nenhum fora) |
| Cobertura dos vínculos — Conta 30 | **99,9%** (14 envios fora: DHL, FEDEX, USPS, uni uni, teste) |
| Card × tabela de vendas | 526 × 525 — divergência única: campanha `TesteMetrics`, excluída de propósito |
| Sequência das mensagens | descendente em todos os fluxos (974→897→769; 311→235) |
| Unidade do analytics | mensagem enviada, confirmado por sonda |
| Crédito por envio | 3,0 — medido |

---

## 10. Manutenção

**Produto novo chega pelo webhook** com `enabled=false` e sem lista/tag. Só recebe vínculo na
ativação. Produto nunca ativado aparecendo como "sem lista" é ruído, não problema — os diagnósticos
já filtram por `enabled = true`.

**Auto-vínculo casa por família, não por SKU.** As listas são nomeadas `[NeuroMind Pro]` e os
produtos chegam como `M1 - NeuroMind Pro (2 Bottles)`. O casamento é por substring sobre uma chave
normalizada (sem espaço, hífen, acento ou caixa). Se um produto não vincula, a causa provável é que
a lista **não existe** na conta — verifique antes de mexer na normalização.

**Mais de uma conta por cliente é suportado** nos dois canais (SlickText e ActiveCampaign). As chaves
são cadastradas pela UI e aparecem mascaradas como `primeiros6…últimos4` nas respostas. A mesma
família em duas contas conta nas duas; a mesma tag nunca conta duas vezes.

---

## 11. Decisões pendentes (não são técnicas)

- Desabilitar `UP2 - NightCalm` e `UP3 - Flex-ImmuneGuard` — produtos que a MailX não atende.
- Confirmar se `smsbrdcst` (5 vendas, $981,92) é da operação.
- Corrigir os links do Horse Peak 6 bottles (`MSI0002A`, `MSI0003A` — link_id 191341/191342), que
  carregam `MS0001-HorsepeakN8N`.
