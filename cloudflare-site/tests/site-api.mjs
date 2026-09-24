import assert from 'node:assert/strict';
import {api} from '../public/site.js';

const originalFetch=globalThis.fetch;
try{
  let calls=0;
  globalThis.fetch=async(path,options)=>{calls++;assert.equal(options.credentials,'same-origin');return Response.json({ok:true})};
  assert.deepEqual(await api('/api/health'),{ok:true});
  assert.equal(calls,1);
  globalThis.fetch=async()=>Response.json({error:'版本已更新'},{status:409});
  await assert.rejects(()=>api('/api/sources',{method:'POST',body:'{}'}),error=>error.status===409&&error.message==='版本已更新');
  globalThis.fetch=async()=>new Response('<html>unavailable</html>',{status:502});
  await assert.rejects(()=>api('/api/health'),error=>error.status===502&&/无法读取/.test(error.message));
  calls=0;
  globalThis.fetch=async()=>{calls++;throw new TypeError('network disconnected')};
  await assert.rejects(()=>api('/api/sources',{method:'POST',body:'{}'}),error=>error.uncertain===true&&/内容仍保留/.test(error.message));
  assert.equal(calls,1,'A failed write must never be retried automatically');
  globalThis.fetch=async(path,{signal})=>new Promise((resolve,reject)=>{
    if(signal.aborted)reject(new DOMException('Aborted','AbortError'));
    else signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
  });
  await assert.rejects(()=>api('/api/health',{timeoutMs:10}),error=>error.name==='AbortError'&&/超时/.test(error.message));
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>api('/api/health',{signal:controller.signal}),error=>error.name==='AbortError');
  console.log('PASS 请求超时与断网反馈、HTTP错误保留、写请求不自动重发');
}finally{globalThis.fetch=originalFetch}
