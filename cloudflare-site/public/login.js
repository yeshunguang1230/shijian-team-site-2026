import {api,whoAmI,$,message} from './site.js';
import {createDraftStore} from './workspace-draft.js';
import {LOGOUT_WARNING} from './logout-notice.js';
const requestedNext=new URLSearchParams(location.search).get('next')||'';
const nextPage=/^\/?admin(?:\.html)?(?:#(?:overview|sources|feedback|members|settings))?$/.test(requestedNext)?requestedNext.replace(/^\//,''):'admin.html';
$('#signedInSection a').href=nextPage;
let lastPassword='';
let currentUserId=null;
const logoutKeyPrefix='shijian.workspace-logout.v1:';
// A logical clock, not a wall clock: every identity-resolving action (the initial
// whoAmI check, each login submit) and every observed same-account logout event
// takes the next tick. This lets a late-arriving result be judged against what
// happened *after* it started, instead of permanently blacklisting an account.
let seqCounter=0;
let latestAppliedSeq=0;
const logoutSeqByAccount=new Map();
function nextSeq(){return ++seqCounter}
function accountIdFromLogoutKey(key){if(typeof key!=='string'||!key.startsWith(logoutKeyPrefix))return null;try{return decodeURIComponent(key.slice(logoutKeyPrefix.length))}catch{return null}}
function show(section){$('#loadingAuth').hidden=true;for(const id of ['loginSection','passwordSection','signedInSection'])$('#'+id).hidden=id!==section}
function resetIdentityUI(){currentUserId=null;lastPassword='';$('#loginForm').reset();$('#passwordForm').reset();$('#signedInName').textContent=''}
// Single gate for both showing an identity and deciding whether to redirect, so a
// rejected/stale result can never still trigger a navigation from elsewhere.
function applyIdentity(user,seq,{failed=false,errorMessage='',forceRedirect=false}={}){
  if(seq<=latestAppliedSeq)return; // superseded by an already-applied, more recent identity result
  if(user&&(logoutSeqByAccount.get(user.id)??0)>seq){
    latestAppliedSeq=seq;resetIdentityUI();show('loginSection');message($('#loginMessage'),'账号已在其他标签页退出登录。',true);return;
  }
  latestAppliedSeq=seq;
  if(failed){show('loginSection');message($('#loginMessage'),errorMessage,true);return}
  currentUserId=user?.id||null;if(!user){show('loginSection');return}if(user.mustChangePassword){showPassword(true);return}if(requestedNext||forceRedirect){location.replace(nextPage);return}$('#signedInName').textContent=`你好，${user.displayName||user.username}`;show('signedInSection')
}
function showPassword(required=false){show('passwordSection');$('#passwordIntro').textContent=required?'首次登录后，请先更换初始密码，再进入工作区。':'更换密码后，会更新当前登录会话。';$('#passwordForm').elements.currentPassword.value=lastPassword}
async function submit(form,fn){const button=form.querySelector('button[type="submit"]');button.disabled=true;try{await fn()}finally{button.disabled=false}}
$('#loginForm').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;submit(form,async()=>{const username=form.elements.username.value.trim();lastPassword=form.elements.password.value;message($('#loginMessage'),'正在登录…');const seq=nextSeq();try{const data=await api('/api/auth/login',{method:'POST',body:JSON.stringify({username,password:lastPassword})});form.elements.password.value='';message($('#loginMessage'),'');applyIdentity(data.user,seq,{forceRedirect:true})}catch(error){lastPassword='';message($('#loginMessage'),error.message,true)}})});
$('#passwordForm').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;submit(form,async()=>{const currentPassword=form.elements.currentPassword.value;const newPassword=form.elements.newPassword.value;if(newPassword!==form.elements.confirmPassword.value){message($('#passwordMessage'),'两次新密码不一致，请重新输入。',true);return}if(newPassword===currentPassword){message($('#passwordMessage'),'新密码需要与当前密码不同。',true);return}try{message($('#passwordMessage'),'正在保存…');await api('/api/auth/password',{method:'POST',body:JSON.stringify({currentPassword,newPassword})});lastPassword='';form.reset();location.replace(nextPage)}catch(error){message($('#passwordMessage'),error.message,true)}})});
async function logout(){if(!confirm(LOGOUT_WARNING))return;try{await api('/api/auth/logout',{method:'POST',body:'{}'});const cleared=currentUserId?createDraftStore(currentUserId).clear():true;resetIdentityUI();show('loginSection');message($('#loginMessage'),cleared?'已退出登录。':'已退出登录，但本机恢复稿未能清除；共用设备请清除此网站的浏览器数据。',!cleared)}catch(error){message($('#passwordSection').hidden?$('#sessionMessage'):$('#passwordMessage'),error.message,true)}}
$('#logout').onclick=logout;$('#passwordLogout').onclick=logout;$('#showChangePassword').onclick=()=>showPassword(false);

const params=new URLSearchParams(location.search);
const loadNotices=[];
if(params.get('reason')==='other-tab-logout')loadNotices.push('账号已在其他标签页退出登录。');
if(params.get('notice')==='local-draft-cleanup')loadNotices.push('本机恢复稿未能清除；共用设备请清除此网站的浏览器数据。');
if(loadNotices.length)message($('#loginMessage'),loadNotices.join(' '),true);

{
  const initialSeq=nextSeq();
  whoAmI().then(user=>applyIdentity(user,initialSeq)).catch(()=>applyIdentity(null,initialSeq,{failed:true,errorMessage:[...loadNotices,'暂时未能检查登录状态，请尝试登录。'].join(' ')}));
}

window.addEventListener('storage',event=>{
  const accountId=accountIdFromLogoutKey(event.key);
  if(!accountId||!event.newValue)return;
  logoutSeqByAccount.set(accountId,nextSeq());
  if(currentUserId!==accountId)return;
  resetIdentityUI();show('loginSection');message($('#loginMessage'),'账号已在其他标签页退出登录。',true);
});
