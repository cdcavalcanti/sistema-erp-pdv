-- =====================================================================
-- 0023 — Isolamento de tenant também nas referências (seção 25, RN-ORG-01)
-- O RLS não vale para a verificação de chave estrangeira: um tenant poderia gravar o id de um
-- registro de outro tenant (ex.: item de tabela de preço apontando para produto alheio). Cada FK
-- entre tabelas de tenant ganha uma FK composta (tenant_id, coluna) → (tenant_id, id).
-- =====================================================================
DO $$
DECLARE
  r record;
  cname text;
  done int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT n.nspname AS nsp, t.relname AS rel, a.attname AS col, rn.nspname AS rnsp, rt.relname AS rrel
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class rt ON rt.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = rt.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
      JOIN pg_attribute ra ON ra.attrelid = rt.oid AND ra.attnum = c.confkey[1]
     WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND ra.attname = 'id' AND a.attname <> 'tenant_id'
       AND NOT t.relispartition AND NOT rt.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = t.oid AND x.attname = 'tenant_id' AND x.attnotnull)
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = rt.oid AND x.attname = 'tenant_id' AND x.attnotnull)
  LOOP
    BEGIN
      EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (tenant_id, id)', left(r.rrel || '_tenant_id_id_uq', 63), r.rnsp, r.rrel);
      cname := left(r.rel || '_' || r.col || '_tenant_fk', 63);
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = cname AND connamespace = r.nsp::regnamespace) THEN
        EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, %I) REFERENCES %I.%I (tenant_id, id)', r.nsp, r.rel, cname, r.col, r.rnsp, r.rrel);
        done := done + 1;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'FK de tenant não criada para %.%(%): %', r.nsp, r.rel, r.col, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE '% FKs compostas por tenant criadas', done;
END $$;
