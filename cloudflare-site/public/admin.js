import {api,whoAmI,arrayOf,$,esc,message} from './site.js';
import {createDraftStore} from './workspace-draft.js';
import {buildFeedbackSummary} from './feedback-export.js';
const state={user:null,sources:[],feedback:[],feedbackReadAt:null,members:[],source:null,newSourceId:null,dirty:false,loaded:new Set(),busy:false,importing:false,feedbackBusy:false,settingsBusy:false,settingsDirty:false,settingsRevision:null,feedbackId:null,sync:null,syncBusy:false,lastSync:null,drafts:null,draftTimer:null,syncTimer:null,leaving:false};
const views={overview:['工作概览','共同维护资料，让每个版本更可靠。'],sources:['共享史料','从文档到证据：检查来源，保存草稿，核验后发布。'],feedback:['团队建议','把想法变成清楚的要求，把改进过程记录下来。'],members:['团队成员','三个独立账号，同一个共同维护的工作区。'],settings:['规则设置','让智能体的回答边界与项目版本始终清楚。']};
const sourceKeys=['title','author','date','period','locator','content','reliability'];
const dateText=value=>{if(!value)return '';const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})};
const newId=prefix=>prefix+crypto.randomUUID().replaceAll('-','');
function loginUrl(){const view=location.hash.slice(1);return 'login.html?next='+encodeURIComponent('admin.html'+(views[view]?'#'+view:''))}
async function request(path,options){try{if(state.leaving)throw Error('此页面已退出登录');const result=await api(path,options);if(state.leaving)throw Error('此页面已退出登录');return result}catch(error){if(error.status===401||(error.status===403&&/密码|password/i.test(error.message))){flushDraft();location.replace(loginUrl())}throw error}}
function updaterName(id){const member=id===state.user?.id?state.user:state.members.find(x=>x.id===id);return member?.displayName||member?.username||'团队成员'}
function renderSourceMeta(item=state.source){$('#sourceMeta').textContent=item?`${item.visibility==='published'?'已发布 · 游客可见':'草稿 · 仅团队可见'}${item.updated_by?' · 更新者：'+updaterName(item.updated_by):''}${item.updated_at?' · '+dateText(item.updated_at):''}`:'新建资料尚未保存到云端'}
function sourceFields(){return $('#sourceForm').elements}
function sourcePending(){return state.busy||state.importing}
function lockForm(form,locked){form.querySelectorAll('input,textarea,select,button').forEach(field=>field.disabled=locked)}
function setDirty(value){if(state.leaving)return;state.dirty=value;$('#sourceDirty').textContent=value?'编辑中 · 尚未保存到云端':'';if(value){clearTimeout(state.draftTimer);state.draftTimer=setTimeout(flushDraft,600)}}
function renderDrafts(){const rows=state.drafts?.list()||[];const choice=$('#draftChoice'),selected=choice.value;choice.innerHTML=rows.map(item=>`<option value="${esc(item.id)}">${esc(item.fields.title||'未命名资料')} · ${esc(dateText(item.savedAt))}</option>`).join('');if(rows.some(item=>item.id===selected))choice.value=selected;$('#draftRecovery').hidden=rows.length===0}
function flushDraft(){clearTimeout(state.draftTimer);if(state.leaving||!state.dirty||!state.drafts)return;const fields=Object.fromEntries(sourceKeys.map(key=>[key,sourceFields()[key].value]));const result=state.drafts.save({id:state.source?.id||state.newSourceId,revision:state.source?.revision||0,visibility:state.source?.visibility||'draft',fields});$('#sourceDirty').textContent=result.ok?'本机恢复稿已保留 · 尚未保存云端':result.message;renderDrafts()}
function lockSourceControls(){const locked=sourcePending();for(const field of sourceFields())field.disabled=locked;for(const id of ['importDocument','newSource','refreshSources','reloadSource','restoreDraft','discardDraft','logout'])$('#'+id).disabled=locked;$('#sourceList').querySelectorAll('[data-source]').forEach(button=>button.disabled=locked)}
function writeSourceFields(item){const fields=sourceFields();$('#sourceForm').reset();for(const key of sourceKeys.filter(key=>key!=='reliability'))fields[key].value=item?.[key]||'';const reliability=item?.reliability||'待核验';if(![...fields.reliability.options].some(x=>x.value===reliability))fields.reliability.add(new Option(reliability,reliability));fields.reliability.value=reliability}
function switchSource(item,force=false){
  if(!force&&sourcePending())return;
  if(!force&&state.dirty&&!confirm('当前史料尚未保存到云端。可用时将保留本机恢复稿，仍要切换吗？'))return;
  if(!force)flushDraft();clearTimeout(state.draftTimer);
  state.source=item?{...item}:null;state.newSourceId=item?.id||newId('S');writeSourceFields(item);
  $('#sourceHeading').textContent=item?'编辑史料':'新建史料';renderSourceMeta(item);
  $('#saveDraft').textContent=item?.visibility==='published'?'收回为草稿':'保存草稿';$('#publishSource').textContent=item?.visibility==='published'?'更新公开资料':'发布到前台';
  $('#sourceConflict').hidden=true;message($('#sourceMessage'),'');message($('#importMessage'),'');setDirty(false);renderSources();renderDrafts();
}
function renderSources(){const search=$('#sourceSearch').value.trim().toLowerCase();const filter=$('#sourceFilter').value;const rows=state.sources.filter(x=>(filter==='all'||x.visibility===filter)&&[x.title,x.author,x.period].join(' ').toLowerCase().includes(search));$('#sourceList').innerHTML=rows.length?rows.map(x=>`<button type="button" class="record ${state.source?.id===x.id?'active':''}" data-source="${esc(x.id)}"><strong>${esc(x.title||'未命名资料')}</strong><small>${esc(x.author||'作者待补充')} · ${esc(x.period||'时期待补充')}</small><span class="pill ${x.visibility==='published'?'':'gold'}">${x.visibility==='published'?'已发布':'草稿'}</span>${x.updated_by?`<small>更新者：${esc(updaterName(x.updated_by))}</small>`:''}</button>`).join(''):'<div class="empty">没有符合条件的史料。<br>点击“新建史料”开始整理。</div>';$('#sourceList').querySelectorAll('[data-source]').forEach(button=>{button.disabled=sourcePending();button.onclick=()=>switchSource(state.sources.find(x=>x.id===button.dataset.source))})}
function checkSourceVersion(){const id=state.source?.id||state.newSourceId;const latest=state.sources.find(x=>x.id===id);if(latest&&latest.revision!==(state.source?.revision||0)){$('#sourceConflict').hidden=false;message($('#sourceMessage'),'云端有新版本，当前编辑内容未被覆盖。可继续保留输入，或读取最新版本后合并。',true)}}
async function loadSources(){const [rows,members]=await Promise.all([request('/api/sources'),state.members.length?Promise.resolve(state.members):request('/api/members')]);state.sources=arrayOf(rows);state.members=arrayOf(members);renderSources();checkSourceVersion()}
async function loadOverview(){const data=await request('/api/admin/overview');$('#statSources').textContent=data.sourceCount??0;$('#statFeedback').textContent=data.feedbackCount??0;$('#statMembers').textContent=data.memberCount??0;$('#statAI').textContent=data.aiConfigured?'已配置':'演示模式';$('#statAISub').textContent=data.aiConfigured?'登录成员可调用真实 AI':'真实 AI 尚未接入'}
function renderFeedback(){const filter=$('#feedbackFilter').value;const rows=state.feedback.filter(x=>filter==='all'||x.status===filter);$('#feedbackList').innerHTML=rows.length?rows.map(x=>`<article class="feedback-card"><div class="feedback-meta"><span>${esc(x.author||'团队成员')} · ${esc(dateText(x.createdAt))}</span><span>${esc(x.category||'建议')}</span></div><h3>${esc(x.title)}</h3>${x.scenario?`<p><b>场景：</b>${esc(x.scenario)}</p>`:''}${x.current?`<p><b>当前问题：</b>${esc(x.current)}</p>`:''}${x.desired?`<p><b>希望结果：</b>${esc(x.desired)}</p>`:''}${x.evidence?`<p><b>证据：</b>${esc(x.evidence)}</p>`:''}${x.acceptance?`<p><b>验收：</b>${esc(x.acceptance)}</p>`:''}${x.updatedBy?`<small class="muted">最近更新：${esc(x.updatedBy)}${x.updatedAt?' · '+esc(dateText(x.updatedAt)):''}</small>`:''}<div class="feedback-bottom"><span class="pill ${x.priority==='P0'?'gold':'gray'}">${esc(x.priority||'P1')}</span><label>处理状态<select data-feedback-status="${esc(x.id)}">${['新建','已确认','开发中','修复待测','已通过','暂缓'].map(status=>`<option ${status===x.status?'selected':''}>${status}</option>`).join('')}</select></label></div></article>`).join(''):'<div class="empty">当前没有符合条件的建议。<br>提出一条具体建议，让团队一起改进。</div>';$('#feedbackList').querySelectorAll('[data-feedback-status]').forEach(select=>{select.disabled=state.feedbackBusy;select.onchange=()=>updateFeedbackStatus(select)})}
async function loadFeedback(){state.feedback=arrayOf(await request('/api/feedback'));state.feedbackReadAt=new Date().toISOString();renderFeedback()}
async function updateFeedbackStatus(select){const item=state.feedback.find(x=>x.id===select.dataset.feedbackStatus);if(!item||state.feedbackBusy)return;const previous=item.status;state.feedbackBusy=true;select.disabled=true;try{const result=await request('/api/feedback',{method:'POST',body:JSON.stringify({...item,status:select.value})});const saved=result.item||result;state.feedback=state.feedback.map(x=>x.id===saved.id?saved:x);message($('#globalMessage'),'建议状态已保存到云端。');try{await loadFeedback()}catch{message($('#globalMessage'),'状态已保存到云端，列表暂未刷新。无需重复提交。',true)}}catch(error){select.value=previous;message($('#globalMessage'),error.status===409?'队友已更新这条建议，你的修改尚未保存。请刷新看板后重新选择。':error.message,true)}finally{state.feedbackBusy=false;renderFeedback()}}
async function loadMembers(){state.members=arrayOf(await request('/api/members'));$('#memberList').innerHTML=state.members.map(x=>`<article class="member-card"><span class="avatar">${esc((x.displayName||x.username||'成').slice(-1))}</span><h3>${esc(x.displayName||x.username)}</h3><p>${esc(x.username)}</p><span class="pill">开发者${x.id===state.user.id?' · 我':''}</span><p style="margin:16px 0 0">${x.mustChangePassword?'等待成员完成首次密码设置':'账号已启用'}</p></article>`).join('')}
let settingsLoadPromise=null;
function loadSettings(){
  if(settingsLoadPromise)return settingsLoadPromise;
  const form=$('#settingsForm');state.settingsBusy=true;lockForm(form,true);
  settingsLoadPromise=(async()=>{
    const [settings,config]=await Promise.all([request('/api/settings'),request('/api/config')]);
    form.elements.version.value=settings.version||'';form.elements.system_prompt.value=settings.system_prompt||'';state.settingsRevision=settings.revision;state.settingsDirty=false;$('#settingsConflict').hidden=true;
    $('#settingsAI').textContent=config.configured?`真实 AI 已配置${config.model?' · '+config.model:''}`:'当前为演示模式。真实 AI 尚未接入，页面不会把演示回答当作模型生成。';
  })().finally(()=>{settingsLoadPromise=null;state.settingsBusy=false;lockForm(form,false)});
  return settingsLoadPromise;
}
function syncStatus(text,offline=false){$('#syncStatus').textContent=text;$('#syncDot').classList.toggle('offline',offline)}
async function checkSync(manual=false){
  if(state.leaving||state.syncBusy||!state.user||document.hidden&&!manual)return;
  state.syncBusy=true;$('#checkSync').disabled=true;
  try{
    const next=await request('/api/sync');
    if(state.leaving)return;
    if(!state.sync)state.sync={...next};
    for(const kind of ['sources','feedback','settings']){
      if(next[kind]===state.sync[kind])continue;
      if(kind==='sources'&&state.loaded.has('sources'))await loadSources();
      if(kind==='feedback'&&state.loaded.has('feedback')){if(state.feedbackBusy||document.activeElement?.dataset?.feedbackStatus)continue;await loadFeedback()}
      if(kind==='settings'&&state.loaded.has('settings')){const latest=await request('/api/settings');if(latest.revision!==state.settingsRevision){$('#settingsConflict').hidden=false;message($('#settingsMessage'),'规则在云端有更新，编辑框保持原样。保存前请载入并合并最新规则。',true)}}
      state.sync[kind]=next[kind];state.loaded.delete('overview');
    }
    if((!location.hash||location.hash==='#overview')&&!state.loaded.has('overview')){await loadOverview();state.loaded.add('overview')}
    state.lastSync=new Date();syncStatus('云端已连接 · '+state.lastSync.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+' 检查 · 编辑内容不会自动上传');
  }catch(error){syncStatus('暂未连上云端 · 编辑内容保留在页面中，恢复连接后重试',true);if(manual)message($('#globalMessage'),error.message,true)}
  finally{state.syncBusy=false;$('#checkSync').disabled=false}
}
function singleFlight(loader){let pending=null;return ()=>{if(!pending)pending=Promise.resolve().then(loader).finally(()=>{pending=null});return pending}}
const loaders={overview:singleFlight(loadOverview),sources:singleFlight(loadSources),feedback:singleFlight(loadFeedback),members:singleFlight(loadMembers),settings:singleFlight(loadSettings)};
async function navigate(){const raw=location.hash.slice(1);const view=views[raw]?raw:'overview';document.querySelectorAll('.section-view').forEach(x=>x.hidden=x.id!=='view-'+view);document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x.dataset.view===view));$('#pageTitle').textContent=views[view][0];$('#pageDescription').textContent=views[view][1];message($('#globalMessage'),'');try{if(!state.loaded.has(view)){await loaders[view]();state.loaded.add(view)}}catch(error){message($('#globalMessage'),error.message,true)}}
$('#sourceForm').addEventListener('input',()=>setDirty(true));$('#sourceSearch').oninput=renderSources;$('#sourceFilter').onchange=renderSources;$('#newSource').onclick=()=>switchSource(null);
$('#refreshSources').onclick=async()=>{if(sourcePending())return;const button=$('#refreshSources');button.disabled=true;try{await loadSources();message($('#globalMessage'),'资料列表已刷新，当前编辑内容保持不变。')}catch(error){message($('#globalMessage'),error.message,true)}finally{button.disabled=sourcePending()}};
$('#sourceForm').addEventListener('submit',async event=>{
  event.preventDefault();if(sourcePending())return;
  const visibility=event.submitter?.value||'draft',fields=sourceFields(),item={};
  for(const key of sourceKeys)item[key]=fields[key].value.trim();
  item.visibility=visibility;item.id=state.source?.id||state.newSourceId;item.revision=state.source?.revision||0;
  if(visibility==='published'&&(!item.author||!item.locator)){message($('#sourceMessage'),'发布前请补充作者 / 机构及出处，方便读者回查原文。',true);return}
  flushDraft();state.busy=true;lockSourceControls();message($('#sourceMessage'),'正在保存到共享资料库…');
  try{
    const result=await request('/api/sources',{method:'POST',body:JSON.stringify({item})});const saved=result.item;
    state.sources=[saved,...state.sources.filter(source=>source.id!==saved.id)];state.drafts?.remove(saved.id);
    switchSource(saved,true);state.loaded.delete('overview');
    message($('#sourceMessage'),visibility==='published'?'已发布，游客刷新前台即可看到。':'草稿已保存到云端，队友的列表会自动检查更新。');
    try{await loadSources()}catch{message($('#sourceMessage'),'已保存到云端，但资料列表刷新失败。无需重新提交；稍后点击“刷新资料列表”即可。',true)}
  }catch(error){if(error.status===409){$('#sourceConflict').hidden=false;message($('#sourceMessage'),'保存未完成：云端已有其他版本，你的输入仍保留。请读取最新版本后合并。',true)}else message($('#sourceMessage'),error.message+'。输入仍保留；恢复连接后可再次保存确认。',true)}
  finally{state.busy=false;lockSourceControls()}
});
$('#reloadSource').onclick=async()=>{if(sourcePending())return;const id=state.source?.id||state.newSourceId;if(state.dirty&&!confirm('读取最新版本会替换编辑框。当前内容将尝试保留为本机恢复稿；重要内容建议先复制备份。继续吗？'))return;flushDraft();state.busy=true;lockSourceControls();try{await loadSources();const latest=state.sources.find(x=>x.id===id);if(!latest){message($('#sourceMessage'),'尚未找到这条云端资料，编辑内容保持不变。',true);return}switchSource(latest,true)}catch(error){message($('#sourceMessage'),error.message,true)}finally{state.busy=false;lockSourceControls()}};
$('#restoreDraft').onclick=()=>{if(sourcePending())return;const draft=state.drafts?.list().find(x=>x.id===$('#draftChoice').value);if(!draft)return;if(state.dirty&&!confirm('恢复会替换当前编辑框。请先复制需要保留的内容，继续吗？'))return;flushDraft();const base=draft.revision>0?{id:draft.id,revision:draft.revision,visibility:draft.visibility,...draft.fields}:null;switchSource(base,true);state.newSourceId=draft.id;writeSourceFields(draft.fields);setDirty(true);checkSourceVersion();message($('#sourceMessage'),'已恢复到编辑框，还未上传云端。检查后点击保存；如有版本冲突，请先合并云端修改。');};
$('#discardDraft').onclick=()=>{if(sourcePending())return;const id=$('#draftChoice').value;if(id&&confirm('只删除这份本机恢复稿，不会删除云端资料。确定吗？')){if(state.drafts.remove(id)){renderDrafts();message($('#sourceMessage'),'本机恢复稿已删除，编辑框和云端资料未改变。')}else message($('#sourceMessage'),'本机恢复稿未能删除，请检查浏览器存储权限。',true)}};
$('#importDocument').onclick=()=>{if(!sourcePending())$('#documentFile').click()};
$('#documentFile').onchange=async event=>{
  const file=event.target.files[0];event.target.value='';if(!file||sourcePending())return;
  if(file.size>10*1024*1024){message($('#importMessage'),'文件超过 10 MB，请分拆或选择更小的文件。',true);return}
  if(sourceFields().content.value.trim()&&!confirm('导入文档会替换当前正文预览，仍要继续吗？'))return;
  state.importing=true;lockSourceControls();message($('#importMessage'),'正在本机提取正文，请稍候…');
  try{const {extractDocument}=await import('./import-document.js');let warning='';const content=await extractDocument(file,{onProgress:progress=>{if(progress.warning)warning=progress.warning;if(progress.message)message($('#importMessage'),progress.message)}});if(typeof content!=='string'||!content.trim())throw Error('没有提取到可用文字。扫描件或图片需要先转换为可复制的文字。');sourceFields().content.value=content;sourceFields().title.value ||= file.name.replace(/\.[^.]+$/,'');setDirty(true);flushDraft();message($('#importMessage'),`已提取 ${content.length.toLocaleString()} 个字符。请检查正文，补充作者与出处，再保存到云端。${warning?' '+warning:''}`)}catch(error){message($('#importMessage'),error.message||'提取失败，请尝试复制文档正文。',true)}finally{state.importing=false;lockSourceControls()}
};
$('#feedbackFilter').onchange=renderFeedback;$('#refreshFeedback').onclick=async()=>{if(state.feedbackBusy)return;try{await loadFeedback();message($('#globalMessage'),'看板已更新。')}catch(error){message($('#globalMessage'),error.message,true)}};
function feedbackSnapshot(){
  if(state.leaving)return '';
  if(state.feedbackBusy){message($('#feedbackExportMessage'),'正在保存建议，请等保存完成后再导出。');return ''}
  const text=buildFeedbackSummary(state.feedback,{filter:$('#feedbackFilter').value,loadedAt:state.feedbackReadAt});
  $('#feedbackExportText').value=text;$('#feedbackExportPanel').hidden=!text;
  if(!text)message($('#feedbackExportMessage'),'当前筛选下没有可导出的建议，可先刷新看板或调整筛选。');
  return text;
}
$('#copyFeedback').onclick=async()=>{
  const text=feedbackSnapshot();if(!text)return;
  const button=$('#copyFeedback');button.disabled=true;
  try{
    if(!globalThis.navigator?.clipboard?.writeText)throw Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    if(!state.leaving)message($('#feedbackExportMessage'),'建议摘要已复制，可粘贴给 Codex 或团队。这是当前列表快照。');
  }catch{
    if(state.leaving)return;
    message($('#feedbackExportMessage'),'无法自动复制，完整摘要已显示在下方。点击“全选摘要”后手动复制，或下载 TXT。',true);
    $('#feedbackExportText').focus();$('#feedbackExportText').select();
  }finally{button.disabled=false}
};
$('#downloadFeedback').onclick=()=>{
  const text=feedbackSnapshot();if(!text)return;
  try{
    const url=URL.createObjectURL(new Blob(['\uFEFF',text],{type:'text/plain;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='史鉴团队建议_'+new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')+'.txt';
    document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    message($('#feedbackExportMessage'),'已请求下载 TXT 摘要。若浏览器未保存，可使用下方文本手动复制。');
  }catch{message($('#feedbackExportMessage'),'浏览器未能下载，完整摘要已显示在下方，可全选后复制。',true)}
};
$('#selectFeedbackExport').onclick=()=>{$('#feedbackExportText').focus();$('#feedbackExportText').select()};
$('#closeFeedbackExport').onclick=()=>{$('#feedbackExportPanel').hidden=true};
$('#feedbackForm').onsubmit=async event=>{event.preventDefault();if(state.feedbackBusy)return;const form=event.currentTarget;const button=form.querySelector('button[type="submit"]');state.feedbackBusy=true;button.disabled=true;lockForm(form,true);state.feedbackId ||= newId('F');const item={id:state.feedbackId,revision:0,status:'新建',owner:'待分配'};for(const key of ['title','category','priority','scenario','desired','evidence','acceptance'])item[key]=form.elements[key].value.trim();try{const result=await request('/api/feedback',{method:'POST',body:JSON.stringify(item)});const saved=result.item||result;state.feedback=[saved,...state.feedback.filter(x=>x.id!==saved.id)];state.feedbackId=null;$('#feedbackRetryChoice').hidden=true;form.reset();message($('#feedbackMessage'),'已提交到云端，队友可在同一看板看到。');state.loaded.delete('overview');try{await loadFeedback()}catch{message($('#feedbackMessage'),'建议已保存到云端，列表暂未刷新。无需重复提交。',true)}}catch(error){if(error.status===409)$('#feedbackRetryChoice').hidden=false;message($('#feedbackMessage'),error.status===409?'云端已有这一条建议，输入仍保留。请先刷新看板核对；确实需要新增时，可选择“新建另一条建议”。':error.message+'。输入仍保留，恢复连接后可重试。',true)}finally{state.feedbackBusy=false;button.disabled=false;lockForm(form,false);renderFeedback()}};
$('#newFeedbackAttempt').onclick=()=>{if(state.feedbackBusy||state.leaving||!state.feedbackId)return;if(!confirm('请先刷新建议看板，确认原提交是否已保存。你已核对，并确定当前内容应作为另一条新建议吗？\n当前输入会保留；这一步不会提交，之后仍需点击提交按钮。'))return;state.feedbackId=newId('F');$('#feedbackRetryChoice').hidden=true;message($('#feedbackMessage'),'已按另一条新建议准备，当前输入保留。请检查内容，再点击“提交到团队看板”。')};
$('#settingsForm').addEventListener('input',()=>{state.settingsDirty=true});
$('#settingsForm').onsubmit=async event=>{event.preventDefault();if(state.settingsBusy)return;const form=event.currentTarget;const button=form.querySelector('button');state.settingsBusy=true;button.disabled=true;lockForm(form,true);try{const saved=await request('/api/settings',{method:'POST',body:JSON.stringify({version:form.elements.version.value.trim(),system_prompt:form.elements.system_prompt.value.trim(),revision:state.settingsRevision})});state.settingsRevision=saved.revision;state.settingsDirty=false;$('#settingsConflict').hidden=true;message($('#settingsMessage'),'规则与项目版本已保存到云端。')}catch(error){if(error.status===409)$('#settingsConflict').hidden=false;message($('#settingsMessage'),error.status===409?'规则保存未完成：队友已更新规则。你的输入仍保留，请载入并合并最新版本。':error.message,true)}finally{state.settingsBusy=false;button.disabled=false;lockForm(form,false)}};
$('#reloadSettings').onclick=async()=>{if(state.settingsBusy)return;if(state.settingsDirty&&!confirm('载入云端新规则会替换当前输入。请先复制要保留的内容，再继续。'))return;try{await loadSettings();message($('#settingsMessage'),'已载入云端最新规则。')}catch(error){message($('#settingsMessage'),error.message,true)}};
function feedbackHasInput(){const fields=$('#feedbackForm').elements;return ['title','scenario','desired','evidence','acceptance'].some(key=>fields?.[key]?.value?.trim())}
function endLocalSession(url='login.html'){
  state.leaving=true;clearTimeout(state.draftTimer);clearInterval(state.syncTimer);
  state.dirty=false;state.settingsDirty=false;state.busy=false;state.importing=false;state.feedbackBusy=false;state.settingsBusy=false;
  state.sources=[];state.feedback=[];state.members=[];state.source=null;state.user=null;state.loaded.clear();
  for(const id of ['sourceForm','feedbackForm','settingsForm'])$('#'+id).reset();
  for(const id of ['sourceList','feedbackList','memberList','draftChoice'])$('#'+id).innerHTML='';
  $('#feedbackExportText').value='';$('#feedbackExportPanel').hidden=true;
  $('#adminApp').hidden=true;$('#authLoading').hidden=false;$('#authLoading').textContent='已退出登录，正在返回登录页…';
  location.replace(url);
}
$('#logout').onclick=async()=>{if(sourcePending()||state.feedbackBusy||state.settingsBusy)return;if((state.dirty||state.settingsDirty||feedbackHasInput()||(state.drafts?.list().length||0)>0)&&!confirm('退出会清除当前账号的本机恢复稿，未保存输入也会离开。请确认重要内容已存入云端，确定退出吗？'))return;try{await api('/api/auth/logout',{method:'POST',body:'{}'});state.leaving=true;clearTimeout(state.draftTimer);const cleared=state.drafts?.clear();endLocalSession('login.html'+(cleared===false?'?notice=local-draft-cleanup':''))}catch(error){message($('#globalMessage'),error.message,true)}};
$('#checkSync').onclick=()=>checkSync(true);
window.addEventListener('beforeunload',event=>{if(state.leaving)return;flushDraft();if(state.dirty||sourcePending()||state.settingsDirty||feedbackHasInput()||state.feedbackBusy||state.settingsBusy){event.preventDefault();event.returnValue=''}});
window.addEventListener('storage',event=>{if(state.user&&event.key===state.drafts?.logoutKey&&event.newValue){state.leaving=true;clearTimeout(state.draftTimer);state.drafts.clear({broadcast:false});endLocalSession()}});
window.addEventListener('hashchange',navigate);window.addEventListener('pageshow',event=>{if(event.persisted)location.reload()});
window.addEventListener('focus',()=>checkSync());window.addEventListener('online',()=>checkSync());window.addEventListener('offline',()=>{flushDraft();syncStatus('当前离线 · 输入尚未同步，请恢复连接后保存',true)});
document.addEventListener('visibilitychange',()=>{if(document.hidden)flushDraft();else checkSync()});
try{state.user=await whoAmI();if(!state.user||state.user.mustChangePassword){location.replace(loginUrl())}else{state.drafts=createDraftStore(state.user.id);$('#userName').textContent=state.user.displayName||state.user.username;$('#userAvatar').textContent=(state.user.displayName||state.user.username).slice(-1);$('#authLoading').hidden=true;$('#adminApp').hidden=false;switchSource(null,true);try{state.sync=await request('/api/sync')}catch{}await navigate();await checkSync();if(!state.leaving)state.syncTimer=setInterval(()=>checkSync(),25000)}}catch(error){$('#authLoading').innerHTML=`无法连接账号服务，请刷新重试。<br><a class="btn secondary" style="margin-top:16px" href="login.html">前往登录</a>`}
