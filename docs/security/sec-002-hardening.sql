-- CREATE POLICY no es idempotente por sí mismo (falla si la policy ya
-- existe) — se resuelve con DROP POLICY IF EXISTS justo antes de cada
-- CREATE, dejando siempre el mismo estado final sin importar cuántas
-- veces se corra el script.
DROP POLICY IF EXISTS deny_all_anon_kv ON public.kv;
CREATE POLICY deny_all_anon_kv
  ON public.kv
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS deny_all_authenticated_kv ON public.kv;
CREATE POLICY deny_all_authenticated_kv
  ON public.kv
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS deny_all_anon_analytics_events ON public.analytics_events;
CREATE POLICY deny_all_anon_analytics_events
  ON public.analytics_events
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS deny_all_authenticated_analytics_events ON public.analytics_events;
CREATE POLICY deny_all_authenticated_analytics_events
  ON public.analytics_events
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

COMMIT;
