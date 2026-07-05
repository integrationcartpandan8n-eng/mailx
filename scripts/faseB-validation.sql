-- Fase B — Validação A/B: agregados via caminho antigo (JSONB) vs colunas novas.
-- Rodar ANTES do deploy (baseline) e DEPOIS (comparação).
-- Deltas esperados e intencionais estão comentados em cada bloco.

-- 1) Receita total (order.paid processed) — esperado: novo >= antigo
--    (DS24 entra no novo; antigo só somava caminhos CartPanda)
SELECT 'receita_total' AS metrica,
  (SELECT COALESCE(SUM(REPLACE(COALESCE(payload->'order'->>'total_price', payload->>'total_price'), ',', '')::numeric), 0)
     FROM webhook_logs WHERE event_type='order.paid' AND status='processed'
     AND REPLACE(COALESCE(payload->'order'->>'total_price', payload->>'total_price', ''), ',', '') ~ '^[0-9]+(\.[0-9]+)?$') AS antigo,
  (SELECT COALESCE(SUM(total_price), 0)
     FROM webhook_logs WHERE event_type='order.paid' AND status='processed') AS novo;

-- 2) Vendas MailX SMS — esperado: novo captura o registro mailx-sms/auto-sms
--    que o antigo perdia (bug do hífen)
SELECT 'vendas_sms' AS metrica,
  (SELECT COUNT(*) FROM webhook_logs WHERE event_type='order.paid'
     AND (payload->'order'->'checkout_params'->>'utm_campaign' ILIKE '%mailxsms%'
          OR payload->'order'->'checkout_params'->>'utm_source' ILIKE '%mailxsms%')) AS antigo,
  (SELECT COUNT(*) FROM webhook_logs WHERE event_type='order.paid'
     AND (COALESCE(utm_source,'') ILIKE '%mailx%' OR COALESCE(utm_campaign,'') ILIKE '%mailx%')
     AND (COALESCE(utm_medium,'') ILIKE '%sms%'
          OR (utm_medium IS NULL AND (REPLACE(COALESCE(utm_source,''),'-','') ILIKE '%mailxsms%'
                                      OR REPLACE(COALESCE(utm_campaign,''),'-','') ILIKE '%mailxsms%')))) AS novo;

-- 3) Vendas MailX Email — esperado: novo pode ser MENOR que antigo
--    (o registro mailx-sms sai do Email e vai pro SMS — correção do bug)
SELECT 'vendas_email' AS metrica,
  (SELECT COUNT(*) FROM webhook_logs WHERE event_type='order.paid'
     AND (payload->'order'->'checkout_params'->>'utm_campaign' ILIKE '%mailx%'
          OR payload->'order'->'checkout_params'->>'utm_source' ILIKE '%mailx%')
     AND COALESCE(payload->'order'->'checkout_params'->>'utm_source','') NOT ILIKE '%mailxsms%'
     AND COALESCE(payload->'order'->'checkout_params'->>'utm_campaign','') NOT ILIKE '%mailxsms%') AS antigo,
  (SELECT COUNT(*) FROM webhook_logs WHERE event_type='order.paid'
     AND (COALESCE(utm_source,'') ILIKE '%mailx%' OR COALESCE(utm_campaign,'') ILIKE '%mailx%')
     AND NOT (COALESCE(utm_medium,'') ILIKE '%sms%'
          OR (utm_medium IS NULL AND (REPLACE(COALESCE(utm_source,''),'-','') ILIKE '%mailxsms%'
                                      OR REPLACE(COALESCE(utm_campaign,''),'-','') ILIKE '%mailxsms%')))) AS novo;

-- 4) Top 5 Produtos — novo deve incluir produtos DS24 (ex.: 'Produto Metrics')
SELECT 'top_produtos_novo' AS metrica, product_name, COUNT(*) AS vendas, COALESCE(SUM(total_price),0) AS receita
FROM webhook_logs
WHERE event_type='order.paid' AND product_name IS NOT NULL
GROUP BY product_name ORDER BY vendas DESC LIMIT 5;
