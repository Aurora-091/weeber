/*
# Create Workflow Canvas Tables

1. New Tables
   - `workflow_templates` — Admin-defined graph-based workflow definitions (template+override pattern)
     - `id` (text, primary key) — unique template identifier/key
     - `vertical` (text, not null) — vertical this template applies to (e.g. 'shopify')
     - `name` (text, not null) — human-readable template name
     - `graph` (jsonb, not null) — full WorkflowGraph JSON (nodes + edges)
     - `active` (boolean, default true) — whether this template is live
     - `created_at` (timestamptz)
     - `updated_at` (timestamptz)

   - `org_workflow_configs` — Per-org overrides on top of a workflow template
     - `org_id` (text, not null) — the org applying overrides
     - `template_key` (text, not null) — references workflow_templates.id
     - `enabled` (boolean, default true) — org can disable a template
     - `overrides` (jsonb) — node-level config overrides keyed by node ID
     - Composite PK: (org_id, template_key)

   - `workflow_runs` — Individual execution instances of a workflow graph
     - `id` (uuid, primary key, auto-generated)
     - `org_id` (text) — owning org
     - `template_key` (text, not null) — which template this run is executing
     - `context` (jsonb, not null) — runtime variables (phone, checkout_token, discount_code, etc.)
     - `current_node_id` (text, not null) — which node the walker is at
     - `status` (text, enum: running/waiting/completed/failed)
     - `next_run_at` (timestamptz) — when to resume (wait nodes)
     - `created_at` (timestamptz)
     - `updated_at` (timestamptz)
     - Indexes: org_id, (status + next_run_at), template_key

2. Modified Tables
   - `scheduled_calls` — Added `workflow_run_id` (text, nullable) column linking a scheduled call
     back to its parent workflow run, with index for lookups.

3. Security
   - RLS enabled on all 3 new tables.
   - Policies scoped to `authenticated` (these are accessed by the backend service role, not anon clients).
   - Service role bypasses RLS, so backend CRUD works. Policies exist as defense-in-depth.

4. Notes
   - The `graph` column stores the full WorkflowGraph type (nodes array + edges array).
   - `org_workflow_configs.overrides` is a Record<nodeId, Record<field, value>> for merchant-editable fields.
   - `workflow_runs.context` accumulates merge-tag variables as the graph walker executes nodes.
*/

-- workflow_templates
CREATE TABLE IF NOT EXISTS workflow_templates (
  id text PRIMARY KEY,
  vertical text NOT NULL,
  name text NOT NULL,
  graph jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workflow_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_select_workflow_templates" ON workflow_templates;
CREATE POLICY "service_select_workflow_templates" ON workflow_templates FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "service_insert_workflow_templates" ON workflow_templates;
CREATE POLICY "service_insert_workflow_templates" ON workflow_templates FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "service_update_workflow_templates" ON workflow_templates;
CREATE POLICY "service_update_workflow_templates" ON workflow_templates FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_delete_workflow_templates" ON workflow_templates;
CREATE POLICY "service_delete_workflow_templates" ON workflow_templates FOR DELETE
  TO authenticated USING (true);

-- org_workflow_configs
CREATE TABLE IF NOT EXISTS org_workflow_configs (
  org_id text NOT NULL,
  template_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  overrides jsonb,
  PRIMARY KEY (org_id, template_key)
);

ALTER TABLE org_workflow_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_select_org_workflow_configs" ON org_workflow_configs;
CREATE POLICY "service_select_org_workflow_configs" ON org_workflow_configs FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "service_insert_org_workflow_configs" ON org_workflow_configs;
CREATE POLICY "service_insert_org_workflow_configs" ON org_workflow_configs FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "service_update_org_workflow_configs" ON org_workflow_configs;
CREATE POLICY "service_update_org_workflow_configs" ON org_workflow_configs FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_delete_org_workflow_configs" ON org_workflow_configs;
CREATE POLICY "service_delete_org_workflow_configs" ON org_workflow_configs FOR DELETE
  TO authenticated USING (true);

-- workflow_runs
CREATE TABLE IF NOT EXISTS workflow_runs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id text,
  template_key text NOT NULL,
  context jsonb NOT NULL,
  current_node_id text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_runs_org_id_idx ON workflow_runs(org_id);
CREATE INDEX IF NOT EXISTS workflow_runs_status_next_run_at_idx ON workflow_runs(status, next_run_at);
CREATE INDEX IF NOT EXISTS workflow_runs_template_key_idx ON workflow_runs(template_key);

ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_select_workflow_runs" ON workflow_runs;
CREATE POLICY "service_select_workflow_runs" ON workflow_runs FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "service_insert_workflow_runs" ON workflow_runs;
CREATE POLICY "service_insert_workflow_runs" ON workflow_runs FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "service_update_workflow_runs" ON workflow_runs;
CREATE POLICY "service_update_workflow_runs" ON workflow_runs FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_delete_workflow_runs" ON workflow_runs;
CREATE POLICY "service_delete_workflow_runs" ON workflow_runs FOR DELETE
  TO authenticated USING (true);

-- Add workflow_run_id column to scheduled_calls
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scheduled_calls' AND column_name = 'workflow_run_id'
  ) THEN
    ALTER TABLE scheduled_calls ADD COLUMN workflow_run_id text;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS scheduled_calls_workflow_run_id_idx ON scheduled_calls(workflow_run_id);
