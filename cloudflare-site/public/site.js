export const $=(s)=>document.querySelector(s);
export const esc=(x)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function api(path,options={}){
  const {timeoutMs=20000,signal:callerSignal,...requestOptions}=options;
  const controller=new AbortController();
  const abortFromCaller=()=>controller.abort(callerSignal.reason);
  if(callerSignal?.aborted)abortFromCaller();
  else callerSignal?.addEventListener('abort',abortFromCaller,{once:true});
  // An explicitly supplied signal (e.g. the AI call's 35-second deadline)
  // owns its deadline; ordinary requests must not leave forms stuck forever.
  const timer=callerSignal?null:setTimeout(()=>controller.abort(),timeoutMs);
  const headers={...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})};
  try{
    const res=await fetch(path,{cache:'no-store',credentials:'same-origin',...requestOptions,headers,signal:controller.signal});
    let data;
    try{data=await res.json()}
    catch{
      if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');
      const error=new Error('云端返回了无法读取的结果，请稍后重试。');error.status=res.status;throw error;
    }
    if(!res.ok){const error=new Error(typeof data?.error==='string'?data.error:data?.message||'操作未完成，请重试');error.status=res.status;error.data=data;throw error}
    return data;
  }catch(error){
    if(error.status)throw error;
    const timeout=controller.signal.aborted;
    const write=requestOptions.method==='POST'&&!path.startsWith('/api/auth/');
    const message=write?'未收到云端确认，内容仍保留。请保持内容不变后重试，或恢复网络后检查云端记录。':timeout?'连接云端超时，请检查网络后重试。':'暂时无法连接云端，请检查网络后重试。';
    const failure=new Error(message);failure.name=timeout?'AbortError':'NetworkError';failure.uncertain=write;throw failure;
  }finally{if(timer!==null)clearTimeout(timer);callerSignal?.removeEventListener('abort',abortFromCaller)}
}
export function message(el,text,error=false){el.textContent=text;el.classList.toggle('error',error)}
export async function whoAmI(){return (await api('/api/auth/me'))?.user||null}
export function arrayOf(data){return Array.isArray(data)?data:data?.items||data?.members||data?.sources||[]}
