/* Validate the upgrade on populated pre-upgrade data, without production I/O. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
try {
  for (const name of ['0001_initial.sql', '0002_accounts.sql']) {
    db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const legacyFeedback = JSON.stringify({ id: 'legacy-feedback', title: '已有团队建议', author: '已有成员', createdAt: '2026-09-20T01:00:00.000Z' });
  db.prepare('INSERT INTO feedback(id,payload,updated_at) VALUES(?,?,?)').run('legacy-feedback', legacyFeedback, '2026-09-20T01:00:00.000Z');
  db.prepare("UPDATE settings SET value=? WHERE key='system_prompt'").run('团队已经修订的规则，必须保留');
  db.prepare("UPDATE settings SET value=? WHERE key='version'").run('v-custom');
  const sources = db.prepare('SELECT * FROM sources ORDER BY id').all();
  const legacySettings = db.prepare('SELECT * FROM settings ORDER BY key').all();

  db.exec(await readFile(new URL('../migrations/0003_collaboration.sql', import.meta.url), 'utf8'));
  assert.deepEqual(db.prepare('SELECT * FROM sources ORDER BY id').all(), sources, 'Migration preserves source bodies and visibility');
  assert.deepEqual(db.prepare('SELECT * FROM settings ORDER BY key').all(), legacySettings, 'Old settings are retained for recovery');
  const feedback = db.prepare("SELECT * FROM feedback WHERE id='legacy-feedback'").get();
  assert.equal(feedback.payload, legacyFeedback); assert.equal(feedback.revision, 1); assert.equal(feedback.updated_by, null);
  const settings = db.prepare('SELECT * FROM team_settings WHERE id=1').get();
  assert.equal(settings.system_prompt, '团队已经修订的规则，必须保留'); assert.equal(settings.version, 'v-custom'); assert.equal(settings.revision, 1);
  const versions = () => Object.fromEntries(db.prepare('SELECT domain,revision FROM sync_versions').all().map((row) => [row.domain, row.revision]));
  assert.deepEqual(versions(), { sources: 1, feedback: 1, settings: 1 });
  db.exec("UPDATE sources SET title='新标题' WHERE id='S001'");
  db.exec("UPDATE feedback SET updated_at='2026-09-24' WHERE id='legacy-feedback'");
  db.exec("UPDATE team_settings SET version='v-next' WHERE id=1");
  assert.deepEqual(versions(), { sources: 2, feedback: 2, settings: 2 });
  db.exec("DELETE FROM feedback WHERE id='legacy-feedback'");
  assert.equal(versions().feedback, 3);
  console.log('Collaboration migration passed: existing sources, feedback and custom rules retained; independent sync triggers work.');
} finally {
  db.close();
}
