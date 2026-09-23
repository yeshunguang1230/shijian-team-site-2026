CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  reliability TEXT NOT NULL DEFAULT '待核验',
  period TEXT NOT NULL DEFAULT '',
  locator TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO settings(key,value) VALUES
  ('system_prompt','你是史鉴历史学习智能体。只使用给定 SOURCES。把关键结论标成事实、推断或争议；每个事实 claim 必须带 source_ids。资料不足时明确写资料不足，禁止虚构引用。只返回 JSON。'),
  ('version','v0.1');
INSERT OR IGNORE INTO sources(id,title,author,reliability,period,locator,content) VALUES
 ('S001','秦统一与中央集权（待核验演示）','项目演示整理','待核验','战国至秦','','演示资料：秦在战国后期通过改革和战争扩张完成统一。正式使用前必须补充教材或权威史料出处。'),
 ('S002','商鞅变法（待核验演示）','项目演示整理','待核验','战国','','演示资料：商鞅变法可用于讨论制度改革、执行机制和国家治理。正式使用前必须由成员 3 核验。'),
 ('S003','材料分析方法','项目组方法卡','方法卡','通用','','按观点—证据—解释组织材料分析，避免把时间先后直接等同于因果。');
