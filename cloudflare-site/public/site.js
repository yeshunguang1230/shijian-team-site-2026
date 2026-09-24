export const $=(s)=>document.querySelector(s);
export const esc=(x)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function api(path,options={}){const headers={...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})};const res=await fetch(path,{cache:'no-store',credentials:'same-origin',...options,headers});let data;try{data=await res.json()}catch{data={error:'服务暂时不可用，请稍后重试'}}if(!res.ok){const error=new Error(typeof data.error==='string'?data.error:data.message||'操作未完成，请重试');error.status=res.status;error.data=data;throw error}return data}
export function message(el,text,error=false){el.textContent=text;el.classList.toggle('error',error)}
export async function whoAmI(){return (await api('/api/auth/me'))?.user||null}
export function arrayOf(data){return Array.isArray(data)?data:data?.items||data?.members||data?.sources||[]}
