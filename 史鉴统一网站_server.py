# -*- coding: utf-8 -*-
"""史鉴云端网站服务器：静态网站 + SQLite 数据 + AI 代理。"""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse,unquote,quote
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError
import datetime
import hmac
import json,os,sqlite3,threading,socket,re
ROOT=Path(__file__).resolve().parent
# 可通过平台挂载的持久化目录保存数据库；本地未设置时仍保存在项目目录。
DATA_DIR=Path(os.environ.get('SHIJIAN_DATA_DIR',str(ROOT))).expanduser().resolve()
DATA_DIR.mkdir(parents=True,exist_ok=True)
DB=DATA_DIR/'史鉴云端.db'; LOCK=threading.Lock()
UP=os.environ.get('SHIJIAN_BASE_URL','').rstrip('/'); KEY=os.environ.get('SHIJIAN_API_KEY',''); MODEL=os.environ.get('SHIJIAN_MODEL',''); ADMIN=os.environ.get('SHIJIAN_ADMIN_TOKEN','').strip()
# 管理员令牌不再隐式使用一个公开可猜的默认值。启动脚本会为本地演示显式设置
# local-dev；公网部署必须在平台环境变量中设置一条新的强令牌。跨域默认关闭，
# 如确需从其它域名调用，可设置逗号分隔的 SHIJIAN_ALLOWED_ORIGINS。
ALLOWED_ORIGINS={x.strip().rstrip('/') for x in os.environ.get('SHIJIAN_ALLOWED_ORIGINS','').split(',') if x.strip()}
MAX_BODY=1024*1024
MAX_PROMPT=30000
MAX_SOURCE_CONTENT=200000
MAX_FEEDBACK_FIELD=12000
ID_RE=re.compile(r'^[A-Za-z0-9_-]{1,64}$')
AI_MAX_MESSAGES=50
AI_MAX_TEXT=20000
AI_MAX_TOTAL=120000
AI_WINDOW_SECONDS=300
AI_MAX_REQUESTS_PER_WINDOW=20
AI_HITS={}; AI_HITS_LOCK=threading.Lock()
BLOCKED_STATIC_SUFFIXES={'.db','.sqlite','.sqlite3','.py','.pyc','.bat','.cmd','.zip','.docx','.md','.txt','.log'}
DEFAULT_PROMPT='你是史鉴历史学习智能体。只使用给定 SOURCES。把关键结论标成事实、推断或争议；每个事实 claim 必须带 source_ids。资料不足时明确写资料不足，禁止虚构引用。只返回 JSON。'
DEMO=[('S001','秦统一与中央集权（待核验演示）','项目演示整理','待核验','战国至秦','','演示资料：秦在战国后期通过改革和战争扩张完成统一。正式使用前必须补充教材或权威史料出处。'),('S002','商鞅变法（待核验演示）','项目演示整理','待核验','战国','','演示资料：商鞅变法可用于讨论制度改革、执行机制和国家治理。正式使用前必须由成员 3 核验。'),('S003','材料分析方法','项目组方法卡','方法卡','通用','','按观点—证据—解释组织材料分析，避免把时间先后直接等同于因果。')]
def db():
 c=sqlite3.connect(DB); c.row_factory=sqlite3.Row; c.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)'); c.execute('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY,title TEXT,author TEXT,date TEXT,reliability TEXT,period TEXT,locator TEXT,content TEXT)'); c.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('system_prompt',?)",(DEFAULT_PROMPT,)); c.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('version','v0.1')");
 if c.execute('SELECT COUNT(*) FROM sources').fetchone()[0]==0:
  c.executemany('INSERT INTO sources(id,title,author,reliability,period,locator,content) VALUES(?,?,?,?,?,?,?)',DEMO)
 c.commit(); return c
def settings():
 c=db(); x={r['key']:r['value'] for r in c.execute('SELECT key,value FROM settings')}; c.close(); return x
def json_out(h,status,v):
 d=json.dumps(v,ensure_ascii=False).encode(); h.send_response(status); h.send_header('Content-Type','application/json; charset=utf-8'); h.send_header('Cache-Control','no-store'); h.send_header('Content-Length',str(len(d))); h.end_headers(); h.wfile.write(d)
class H(SimpleHTTPRequestHandler):
 def __init__(self,*a,**k): super().__init__(*a,directory=str(ROOT),**k)
 def end_headers(self):
  # 同源请求没有 Origin；只有显式列入白名单的跨域请求才获得 CORS 响应头。
  origin=self.headers.get('Origin','').rstrip('/')
  if origin and (origin in ALLOWED_ORIGINS or origin in {'http://127.0.0.1:8772','http://localhost:8772'}):
   self.send_header('Access-Control-Allow-Origin',origin); self.send_header('Vary','Origin'); self.send_header('Access-Control-Allow-Headers','Content-Type,X-Admin-Token,Authorization'); self.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS')
  self.send_header('X-Content-Type-Options','nosniff'); self.send_header('Referrer-Policy','same-origin'); self.send_header('X-Frame-Options','SAMEORIGIN')
  super().end_headers()
 def do_OPTIONS(self): self.send_response(204); self.end_headers()
 def body(self):
  try: n=int(self.headers.get('Content-Length','0'))
  except ValueError: raise ValueError('无效的请求长度')
  if n<0 or n>MAX_BODY: raise ValueError('请求内容过大（上限 1 MB）')
  if n and self.headers.get('Content-Type','').split(';',1)[0].lower()!='application/json': raise ValueError('POST 必须使用 application/json')
  raw=self.rfile.read(n)
  value=json.loads(raw or b'{}')
  if not isinstance(value,dict): raise ValueError('JSON 根对象必须是对象')
  return value
 def admin(self):
  supplied=self.headers.get('X-Admin-Token','')
  return bool(ADMIN) and hmac.compare_digest(supplied,ADMIN)
 def _static_blocked(self,path):
  """拒绝把数据库、源码、项目包等部署文件当作静态资源公开。"""
  try: decoded=unquote(path)
  except Exception: return True
  pieces=[x for x in decoded.split('/') if x]
  if any(x in {'.','..'} or x.startswith('.') for x in pieces): return True
  name=pieces[-1] if pieces else ''
  return Path(name).suffix.lower() in BLOCKED_STATIC_SUFFIXES
 def _ai_allowed(self):
  """简单的进程内限流，避免公开 AI 代理被无限刷量。"""
  now=datetime.datetime.now(datetime.timezone.utc).timestamp(); ip=self.client_address[0] if self.client_address else 'unknown'
  with AI_HITS_LOCK:
   hits=[t for t in AI_HITS.get(ip,[]) if now-t<AI_WINDOW_SECONDS]
   if len(hits)>=AI_MAX_REQUESTS_PER_WINDOW:
    AI_HITS[ip]=hits; return False
   hits.append(now); AI_HITS[ip]=hits
   if len(AI_HITS)>2000:
    for k,v in list(AI_HITS.items()):
     if not v or now-v[-1]>=AI_WINDOW_SECONDS: AI_HITS.pop(k,None)
   return True
 def _ai_messages(self,data):
  messages=data.get('messages')
  if not isinstance(messages,list) or not messages or len(messages)>AI_MAX_MESSAGES: raise ValueError(f'messages 必须是 1-{AI_MAX_MESSAGES} 条的数组')
  clean=[]; total=0
  for i,m in enumerate(messages):
   if not isinstance(m,dict): raise ValueError(f'messages[{i}] 必须是对象')
   role=m.get('role'); content=m.get('content')
   if role not in {'system','user','assistant'}: raise ValueError(f'messages[{i}].role 不合法')
   if not isinstance(content,str) or not content.strip(): raise ValueError(f'messages[{i}].content 必须是文本')
   if len(content)>AI_MAX_TEXT: raise ValueError(f'messages[{i}].content 过长')
   total+=len(content)
   if total>AI_MAX_TOTAL: raise ValueError(f'messages 内容总长度不能超过 {AI_MAX_TOTAL} 字符')
   clean.append({'role':role,'content':content})
  return clean
 def _text(self,value,name,limit=MAX_FEEDBACK_FIELD):
  if value is None: return ''
  if not isinstance(value,(str,int,float)): raise ValueError(f'{name} 必须是文本')
  s=str(value).strip()
  if len(s)>limit: raise ValueError(f'{name} 过长')
  return s
 def _feedback(self,data):
  if not isinstance(data,dict): raise ValueError('反馈必须是对象')
  x=dict(data); fid=self._text(x.get('id'),'id',64)
  if not fid or not ID_RE.fullmatch(fid): raise ValueError('id 只能包含字母、数字、下划线或短横线')
  # 只保存预期字段，避免把任意大型/敏感对象写入共享数据库。
  fields=('createdAt','author','category','priority','title','targetVersion','scenario','current','desired','evidence','acceptance','notes','status','owner','retest')
  clean={'id':fid}
  for k in fields: clean[k]=self._text(x.get(k,''),k)
  if len(clean['title'])>300: raise ValueError('标题过长')
  if clean['priority'] and clean['priority'] not in {'P0','P1','P2'}: raise ValueError('priority 必须是 P0、P1 或 P2')
  if clean['status'] and clean['status'] not in {'新建','已确认','开发中','修复待测','已通过','暂缓'}: raise ValueError('status 不在允许范围内')
  return clean
 def _source(self,x):
  if not isinstance(x,dict): raise ValueError('史料条目必须是对象')
  sid=self._text(x.get('id'),'史料 ID',64)
  if not sid or not ID_RE.fullmatch(sid): raise ValueError('史料 ID 格式不正确')
  return (sid,self._text(x.get('title',''),'标题',500),self._text(x.get('author',''),'作者',300),self._text(x.get('date',''),'日期',100),self._text(x.get('reliability','待核验'),'可靠性',100),self._text(x.get('period',''),'时期',200),self._text(x.get('locator',''),'页码或链接',1000),self._text(x.get('content',''),'内容',MAX_SOURCE_CONTENT))
 def do_GET(self):
  p=urlparse(self.path).path
  if p=='/api/health': json_out(self,200,{'ok':True,'ai_configured':bool(UP and KEY and MODEL)}); return
  if p=='/api/config': json_out(self,200,{'configured':bool(UP and KEY and MODEL),'model':MODEL if UP and KEY and MODEL else ''}); return
  if p=='/api/settings':
   x=settings(); json_out(self,200,{'system_prompt':x.get('system_prompt',''),'version':x.get('version','')}); return
  if p=='/api/sources':
   c=db(); rows=[dict(x) for x in c.execute('SELECT id,title,author,date,reliability,period,locator,content FROM sources ORDER BY id')]; c.close(); json_out(self,200,rows); return
  if p=='/api/feedback':
   try:
    c=db(); c.execute('CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL)'); rows=[json.loads(x['payload']) for x in c.execute('SELECT payload FROM feedback ORDER BY updated_at DESC LIMIT 1000')]; c.close(); json_out(self,200,rows)
   except Exception: json_out(self,500,{'error':'读取反馈失败'})
   return
  # 根路径直接进入统一入口，避免 SimpleHTTPRequestHandler 暴露目录列表。
  if p in ('','/'):
   self.send_response(302); self.send_header('Location','/'+quote('史鉴团队网站.html')); self.end_headers(); return
  if self._static_blocked(p): json_out(self,404,{'error':'资源不存在'}); return
  return super().do_GET()
 def do_POST(self):
  p=urlparse(self.path).path
  try: data=self.body()
  except Exception as e: json_out(self,400,{'error':str(e)}); return
  if p=='/api/settings':
    if not self.admin(): json_out(self,403,{'error':'管理员令牌不正确'}); return
    try:
     prompt=self._text(data.get('system_prompt',''),'system_prompt',MAX_PROMPT)
     version=self._text(data.get('version',''),'version',100)
     with LOCK:
      c=db(); c.execute('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)',('system_prompt',prompt)); c.execute('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)',('version',version)); c.commit(); c.close()
     json_out(self,200,{'ok':True})
    except ValueError as e: json_out(self,400,{'error':str(e)})
    except Exception: json_out(self,500,{'error':'保存设置失败'})
    return
  if p=='/api/sources':
    if not self.admin(): json_out(self,403,{'error':'管理员令牌不正确'}); return
    try:
     items=data.get('items',[])
     if not isinstance(items,list) or len(items)>1000: raise ValueError('items 必须是最多 1000 条的数组')
     rows=[self._source(x) for x in items]
     if len({x[0] for x in rows})!=len(rows): raise ValueError('史料 ID 不能重复')
     with LOCK:
      c=db(); c.execute('DELETE FROM sources'); c.executemany('INSERT INTO sources(id,title,author,date,reliability,period,locator,content) VALUES(?,?,?,?,?,?,?,?)',rows); c.commit(); c.close()
     json_out(self,200,{'ok':True,'count':len(rows)})
    except ValueError as e: json_out(self,400,{'error':str(e)})
    except Exception: json_out(self,500,{'error':'保存史料失败'})
    return
  if p=='/api/feedback':
    try:
     x=self._feedback(data)
     stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
     with LOCK:
      c=db(); c.execute('CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL)'); c.execute('INSERT OR REPLACE INTO feedback VALUES(?,?,?)',(x['id'],json.dumps(x,ensure_ascii=False,separators=(',',':')),stamp)); c.commit(); c.close()
     json_out(self,200,x)
    except ValueError as e: json_out(self,400,{'error':str(e)})
    except Exception: json_out(self,500,{'error':'保存反馈失败'})
    return
  if p=='/api/v1/chat/completions':
    if not (UP and KEY and MODEL): json_out(self,503,{'error':'AI 未配置，请在服务器设置 SHIJIAN_BASE_URL、SHIJIAN_API_KEY、SHIJIAN_MODEL'}); return
    try:
     if not self._ai_allowed(): self.send_response(429); self.send_header('Retry-After',str(AI_WINDOW_SECONDS)); self.end_headers(); return
     original=data
     messages=self._ai_messages(original)
     data={'model':MODEL,'messages':messages}
     # 只转发页面实际需要的可选生成参数，避免把任意扩展字段转给上游。
     for k in ('temperature','top_p','max_tokens','response_format'):
      if k in original: data[k]=original[k]
     url=UP if UP.endswith('/chat/completions') else UP+'/chat/completions'
     if urlparse(url).scheme not in ('http','https') or not urlparse(url).netloc: raise ValueError('AI 地址必须是 http 或 https')
     req=Request(url,data=json.dumps(data,ensure_ascii=False).encode(),method='POST',headers={'Content-Type':'application/json','Authorization':'Bearer '+KEY})
     with urlopen(req,timeout=75) as r: out=r.read(); self.send_response(r.status); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Content-Length',str(len(out))); self.end_headers(); self.wfile.write(out)
    except HTTPError as e: json_out(self,e.code,{'error':'上游 AI 错误','detail':e.read().decode(errors='replace')[:2000]})
    except ValueError as e: json_out(self,400,{'error':str(e)})
    except Exception as e: json_out(self,502,{'error':'AI 连接失败','detail':str(e)[:500]})
    return
  json_out(self,404,{'error':'unknown endpoint'})
if __name__=='__main__':
 port=int(os.environ.get('PORT',os.environ.get('SHIJIAN_PORT','8772')))
 db(); print('统一云端网站：http://127.0.0.1:%s/史鉴团队网站.html'%port);
 try:
  for ip in sorted({x for x in socket.gethostbyname_ex(socket.gethostname())[2] if not x.startswith('127.')}): print('队友访问：http://%s:%s/史鉴团队网站.html'%(ip,port))
 except Exception: pass
 print('AI 已配置：',bool(UP and KEY and MODEL)); ThreadingHTTPServer(('0.0.0.0',port),H).serve_forever()

