-- Preserve existing content while adding atomic, shared revision checks.
ALTER TABLE feedback ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE feedback ADD COLUMN updated_by TEXT REFERENCES users(id);

-- One row makes the prompt and its display version an atomic unit.
-- Keep the old settings table intact for backup/rollback; the current API and AI
-- read this migrated row instead. No account or source data is replaced.
CREATE TABLE team_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  system_prompt TEXT NOT NULL,
  version TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id)
);
INSERT INTO team_settings(id,system_prompt,version,revision,updated_at)
SELECT 1,
  COALESCE((SELECT value FROM settings WHERE key='system_prompt'),''),
  COALESCE((SELECT value FROM settings WHERE key='version'),'v0.1'),
  1,strftime('%Y-%m-%dT%H:%M:%fZ','now');

-- Lightweight domain counters do not expose titles, document contents or users.
CREATE TABLE sync_versions (
  domain TEXT PRIMARY KEY CHECK (domain IN ('sources','feedback','settings')),
  revision INTEGER NOT NULL DEFAULT 1
);
INSERT INTO sync_versions(domain) VALUES('sources'),('feedback'),('settings');
CREATE TRIGGER sources_sync_insert AFTER INSERT ON sources BEGIN
  UPDATE sync_versions SET revision=revision+1 WHERE domain='sources';
END;
CREATE TRIGGER sources_sync_update AFTER UPDATE ON sources BEGIN
  UPDATE sync_versions SET revision=revision+1 WHERE domain='sources';
END;
CREATE TRIGGER sources_sync_delete AFTER DELETE ON sources BEGIN
  UPDATE sync_versions SET revision=revision+1 WHERE domain='sources';
END;
CREATE TRIGGER feedback_sync_insert AFTER INSERT ON feedback BEGIN
  UPDATE sync_versions SET revision=revision+1 WHERE domain='feedback';
END;
CREATE TRIGGER feedback_sync_update AFTER UPDATE ON feedback BEGIN
  UPDATE sync_versions SET revision=revision+1 WHERE domain='feedback';
END;
CREATE TRIGGER feedback_sync_delete AFTER DELETE ON feedback BEGIN
  UPDATE sync_versions SET revision=revision+1 WHERE domain='feedback';
END;
CREATE TRIGGER settings_sync_update AFTER UPDATE ON team_settings BEGIN
  UPDATE sync_versions SET revision=revision+1 WHERE domain='settings';
END;
