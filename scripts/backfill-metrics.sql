-- =============================================================
-- Backfill Fase A — popula colunas normalizadas em webhook_logs
-- a partir do payload JSONB histórico. Idempotente (WHERE total_price IS NULL).
-- EXECUÇÃO MANUAL, uma única vez, após deploy da Fase A.
-- =============================================================

-- 1) CartPanda (order.paid / abandoned_cart / card.declined)
UPDATE webhook_logs SET
  total_price = CASE
    WHEN REPLACE(COALESCE(payload->'order'->>'total_price', payload->'data'->>'total_price', payload->>'total_price'), ',', '') ~ '^[0-9]+(\.[0-9]+)?$'
    THEN REPLACE(COALESCE(payload->'order'->>'total_price', payload->'data'->>'total_price', payload->>'total_price'), ',', '')::numeric
    ELSE NULL END,
  currency = COALESCE(payload->'order'->>'currency', payload->>'currency'),
  product_name = COALESCE(
    payload->'order'->'line_items'->0->>'title',
    payload->'data'->'cart_line_items'->0->'variant'->>'sku',
    payload->'order'->'line_items'->0->>'sku'),
  product_external_id = COALESCE(
    payload->'order'->'line_items'->0->>'product_id',
    payload->'order'->'line_items'->0->>'sku'),
  utm_source   = COALESCE(payload->'order'->'checkout_params'->>'utm_source',   payload->'data'->'checkout_params'->>'utm_source',   payload->'checkout_params'->>'utm_source'),
  utm_medium   = COALESCE(payload->'order'->'checkout_params'->>'utm_medium',   payload->'data'->'checkout_params'->>'utm_medium',   payload->'checkout_params'->>'utm_medium'),
  utm_campaign = COALESCE(payload->'order'->'checkout_params'->>'utm_campaign', payload->'data'->'checkout_params'->>'utm_campaign', payload->'checkout_params'->>'utm_campaign'),
  utm_content  = COALESCE(payload->'order'->'checkout_params'->>'utm_content',  payload->'data'->'checkout_params'->>'utm_content',  payload->'checkout_params'->>'utm_content'),
  utm_term     = COALESCE(payload->'order'->'checkout_params'->>'utm_term',     payload->'data'->'checkout_params'->>'utm_term',     payload->'checkout_params'->>'utm_term')
WHERE source = 'cartpanda' AND total_price IS NULL;

-- 2) Digistore24 (flat)
UPDATE webhook_logs SET
  total_price = CASE
    WHEN REPLACE(COALESCE(payload->>'amount_brutto', payload->>'transaction_amount'), ',', '') ~ '^[0-9]+(\.[0-9]+)?$'
    THEN REPLACE(COALESCE(payload->>'amount_brutto', payload->>'transaction_amount'), ',', '')::numeric
    ELSE NULL END,
  currency = COALESCE(payload->>'currency', payload->>'transaction_currency'),
  product_name = payload->>'product_name',
  product_external_id = payload->>'product_id',
  utm_source   = payload->>'utm_source',
  utm_medium   = payload->>'utm_medium',
  utm_campaign = payload->>'utm_campaign',
  utm_content  = payload->>'utm_content',
  utm_term     = payload->>'utm_term',
  affiliate_name = payload->>'affiliate_name'
WHERE source = 'digistore24' AND total_price IS NULL;

-- 3) ClickBank
UPDATE webhook_logs SET
  total_price = CASE
    WHEN payload->>'totalOrderAmount' ~ '^[0-9]+(\.[0-9]+)?$'
    THEN (payload->>'totalOrderAmount')::numeric
    ELSE NULL END,
  currency = payload->>'currency',
  product_name = payload->'lineItems'->0->>'productTitle',
  product_external_id = payload->'lineItems'->0->>'itemNo',
  tracking_code = (
    SELECT string_agg(value, ',')
    FROM jsonb_array_elements_text(COALESCE(payload->'trackingCodes', '[]'::jsonb)) AS value
  )
WHERE source = 'clickbank' AND total_price IS NULL;

-- 4) Verificação pós-backfill
SELECT source, COUNT(*) AS total,
       COUNT(total_price) AS com_valor,
       COUNT(utm_source) AS com_utm,
       COUNT(affiliate_name) AS com_afiliado
FROM webhook_logs GROUP BY source ORDER BY source;
