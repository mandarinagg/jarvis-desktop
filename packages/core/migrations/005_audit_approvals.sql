-- Phase 4 (ADR-018): who let each tool call run. policy (read class), rule (an owner rule in
-- permissions.json) or owner:<client> (an explicit confirmation). Null when denied.
ALTER TABLE audit_log ADD COLUMN approved_by TEXT;
