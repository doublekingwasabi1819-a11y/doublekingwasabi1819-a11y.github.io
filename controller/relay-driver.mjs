import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,realpath} from 'node:fs/promises';
import {isAbsolute,join,parse,resolve} from 'node:path';
import {chromium as installedChromium} from 'playwright';
import {BrowserControllerError} from './core.mjs';

export const RELAY_ORIGIN='https://doublekingwasabi1819-a11y.github.io';
// Public endpoint, pinned independently so this controller remains a standalone
// package. This is a URL, never an API key or an imported account credential.
export const RELAY_BACKEND='https://mukbnmewwoeweogmcuno.supabase.co/functions/v1/relay';
const ASSETS=new Map([
  ['/', 'document'],['/index.html','document'],['/app.mjs','script'],
  ['/api.mjs','script'],['/config.mjs','script'],['/engine.mjs','script'],
  ['/sidebar.mjs','script'],['/dm-ui.mjs','script'],['/updates-ui.mjs','script'],['/hardware-ui.mjs','script'],
  ['/style.css','stylesheet'],['/ui.css','stylesheet'],['/inbox.css','stylesheet'],
  ['/updates.css','stylesheet'],['/hardware.css','stylesheet'],['/favicon.svg','image']
]);
const SPECS=[
  {key:'room',selector:'#nav a.nav-item[href="#room"]',tag:'A',role:'link',name:'My room',label:'My room',href:'#room'},
  {key:'overview',selector:'#nav a.nav-item[href="#overview"]',tag:'A',role:'link',name:'Overview',label:'Overview',href:'#overview'},
  {key:'inbox',selector:'#dm-notification[href="#inbox"]',tag:'A',role:'link',name:'Private inbox',label:'Inbox',href:'#inbox',textLabel:true},
  {key:'refresh',selector:'button[data-action="refresh"][aria-label="Refresh board"]',tag:'BUTTON',role:'button',name:'Refresh board',label:'Refresh board',action:'refresh'},
  {key:'inbox-refresh',selector:'#dm-root button[data-dm-action="refresh"]',tag:'BUTTON',role:'button',name:'Refresh inbox',label:'Refresh',dmAction:'refresh'}
];
const opaque=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const fail=code=>{throw new BrowserControllerError(code);};
const same=(a,b)=>a.workspaceId===b.workspaceId&&a.accountId.toLowerCase()===b.accountId.toLowerCase()&&a.agentId.toLowerCase()===b.agentId.toLowerCase()&&a.runId===b.runId;

async function privateDirectory(path,{create=false}={}){
  if(create){try{await mkdir(path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}}
  const stat=await lstat(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||typeof process.getuid!=='function'||stat.uid!==process.getuid()||await realpath(path)!==path||path===parse(path).root)throw new TypeError('A canonical host-owned private profile directory is required.');
}
function canonicalBinding(value){
  if(!plain(value)||!opaque(value.workspaceId)||!uuid(value.accountId)||!uuid(value.agentId)||!opaque(value.runId))fail('AUTH_REQUIRED');
  return Object.freeze({workspaceId:value.workspaceId,accountId:value.accountId.toLowerCase(),agentId:value.agentId.toLowerCase(),runId:value.runId});
}
function workerSession(value,binding,now){
  if(!plain(value)||value.role!=='worker'||value.enabled!==true||!Array.isArray(value.scopes)||!value.scopes.includes('browser:control'))fail('FORBIDDEN');
  const authority=canonicalBinding(value.binding);
  if(!same(authority,binding))fail('STALE_SESSION');
  if(typeof value.token!=='string'||!/^[a-f0-9]{64}$/.test(value.token)||typeof value.expiresAt!=='string'||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=now())fail('AUTH_REQUIRED');
  return Object.freeze({token:value.token,expiresAt:value.expiresAt,binding:authority});
}
function pageRoute(url){
  try{const u=new URL(url);if(u.origin!==RELAY_ORIGIN||u.username||u.password||u.pathname!=='/'||u.search||!['#room','#overview','#inbox',''].includes(u.hash))return null;return u.hash.slice(1)||'room';}catch{return null;}
}
function assetRequest(request){
  let u;try{u=new URL(request.url());}catch{return null;}
  if(u.origin!==RELAY_ORIGIN||u.username||u.password||u.hash||request.method()!=='GET'||request.redirectedFrom())return null;
  if(u.search&&(!/^\?v=[A-Za-z0-9_-]{1,80}$/.test(u.search)))return null;
  const type=ASSETS.get(u.pathname);if(!type||request.resourceType()!==type)return null;
  if(type==='document'&&(!request.isNavigationRequest()||u.pathname!=='/'||u.search))return null;
  if(type!=='document'&&request.isNavigationRequest())return null;
  return {url:RELAY_ORIGIN+u.pathname,type};
}
function readRequest(request,token){
  if(request.url()!==RELAY_BACKEND||request.method()!=='POST'||request.isNavigationRequest()||!['fetch','xhr'].includes(request.resourceType())||request.redirectedFrom())return null;
  const headers=request.headers();
  if(headers.authorization!==`Bearer ${token}`||headers['content-type']!=='application/json'||headers.cookie)return null;
  const raw=request.postData();if(typeof raw!=='string'||Buffer.byteLength(raw)>1024)return null;
  let body;try{body=JSON.parse(raw);}catch{return null;}
  if(!plain(body)||Object.keys(body).length!==2||!['context','dm.inbox'].includes(body.action)||!plain(body.data)||Object.keys(body.data).length)return null;
  return {action:body.action,body:JSON.stringify({action:body.action,data:{}})};
}
function checkedContext(value,binding){
  const user=value?.user,actor=value?.actor;
  if(!user||user.role!=='worker'||user.enabled!==true||!uuid(user.id)||!uuid(user.agentId)||user.id.toLowerCase()!==binding.accountId||user.agentId.toLowerCase()!==binding.agentId||!actor||actor.owner!==false||!uuid(actor.id)||actor.id.toLowerCase()!==binding.agentId)fail('FORBIDDEN');
  if(actor.session!==binding.runId)fail('STALE_SESSION');
}
function checkedInbox(value,binding){
  const count=x=>Number.isSafeInteger(x)&&x>=0;
  if(!plain(value)||!Array.isArray(value.contacts)||value.contacts.length>1000||!Array.isArray(value.threads)||value.threads.length>1000||!count(value.unreadCount))fail('FORBIDDEN');
  for(const c of value.contacts)if(!uuid(c?.id)||c.id.toLowerCase()===binding.accountId||typeof c.name!=='string'||c.name.length>200||!['worker','manager'].includes(c.role)||typeof c.enabled!=='boolean')fail('FORBIDDEN');
  for(const thread of value.threads){
    const a=thread?.participantA,b=thread?.participantB,m=thread?.lastMessage;
    if(!uuid(a)||!uuid(b)||a.toLowerCase()===b.toLowerCase()||![a.toLowerCase(),b.toLowerCase()].includes(binding.accountId)||!count(thread.unreadCount)||!uuid(m?.id)||!uuid(m.senderId)||!uuid(m.recipientId)||m.senderId.toLowerCase()===m.recipientId.toLowerCase()||![a.toLowerCase(),b.toLowerCase()].includes(m.senderId.toLowerCase())||![a.toLowerCase(),b.toLowerCase()].includes(m.recipientId.toLowerCase())||typeof m.body!=='string'||[...m.body].length>12000||typeof m.createdAt!=='string'||m.createdAt.length>100||!(m.readAt===null||typeof m.readAt==='string'&&m.readAt.length<=100))fail('FORBIDDEN');
  }
}

/**
 * Opt-in, read-only Relay adapter. This module does not start a service, import
 * cookies, extract a browser token, or log in. resolveWorkerSession is a TRUSTED
 * HOST hook after live Relay authorization and explicit browser delegation. It
 * returns {binding, role:'worker', enabled:true, token, expiresAt, scopes}.
 *
 * Wire the same live resolver into createBrowserController.authorize. The host
 * must additionally authorize browser_open/browser_click/browser_close, supply
 * a fresh canonical 0700 profile root, run a non-root sandbox-capable Chromium,
 * and enforce OS network egress. Routing/CSP are defense in depth, not an OS
 * sandbox. No DM reads enter observations; screenshots mask workspace content.
 * Fill/send/mark-read/update actions are intentionally unavailable. Future DM
 * support needs a recipient-resolved, payload-bound host approval contract.
 */
export function createRelayDriverFactory({profileRoot,resolveWorkerSession,chromium=installedChromium,headless=true,now=Date.now}={}){
  if(typeof profileRoot!=='string'||!isAbsolute(profileRoot)||resolve(profileRoot)===parse(resolve(profileRoot)).root||typeof resolveWorkerSession!=='function'||typeof now!=='function'||typeof headless!=='boolean'||!chromium||typeof chromium.launchPersistentContext!=='function')throw new TypeError('Trusted worker session and private Chromium host configuration are required.');
  profileRoot=resolve(profileRoot);
  const active=new Set();
  return async function createDriver({binding}){
    binding=canonicalBinding(binding);
    const profileId=createHash('sha256').update(JSON.stringify(['relay-read-v1',binding.workspaceId,binding.accountId])).digest('hex');
    if(active.has(profileId))fail('LIMIT');active.add(profileId);
    let context,page,initialSession,revoked=false,closed=false,closureComplete=false,closing,targets=new Map();
    async function freshSession(){
      if(closed||revoked)fail('AUTH_REQUIRED');
      let current;try{current=workerSession(await resolveWorkerSession(binding),binding,now);}catch(error){revoked=true;throw new BrowserControllerError(['FORBIDDEN','STALE_SESSION','AUTH_REQUIRED'].includes(error?.code)?error.code:'AUTH_REQUIRED');}
      if(initialSession&&(current.token!==initialSession.token||current.expiresAt!==initialSession.expiresAt)){revoked=true;fail('STALE_SESSION');}
      return current;
    }
    async function releaseTargets(){const old=targets;targets=new Map();await Promise.all([...old.values()].map(t=>t.handle.dispose().catch(()=>{})));}
    async function closeDriver(){
      if(closureComplete)return;if(closing)return closing;
      closed=true;closing=(async()=>{await releaseTargets();if(context)await context.close();closureComplete=true;active.delete(profileId);})();
      try{await closing;}finally{closing=null;}
    }
    const safeError=error=>new BrowserControllerError(['FORBIDDEN','STALE_SESSION','AUTH_REQUIRED','STALE_OBSERVATION','LIMIT'].includes(error?.code)?error.code:'INTERNAL');
    const protectedOperation=operation=>async(...args)=>{try{return await operation(...args);}catch(error){if(revoked)await closeDriver().catch(()=>{});throw safeError(error);}};
    async function assertPage(){await freshSession();if(!page||page.isClosed()||!pageRoute(page.url()))fail('STALE_OBSERVATION');}
    try{
      initialSession=await freshSession();
      await privateDirectory(profileRoot);const profile=join(profileRoot,profileId);await privateDirectory(profile,{create:true});
      context=await chromium.launchPersistentContext(profile,{headless,chromiumSandbox:true,acceptDownloads:false,serviceWorkers:'block',permissions:[],viewport:{width:1280,height:720}});
      context.setDefaultTimeout(3000);await context.clearPermissions();await context.clearCookies();
      // Known session only; never restore authority from a persisted profile.
      await context.addInitScript(({origin,base,token,expiresAt})=>{
        if(location.origin!==origin)return;
        localStorage.clear();sessionStorage.clear();
        sessionStorage.setItem('relay-account-session-v2',JSON.stringify({base,token,expiresAt}));
        // Mouse movement uses actual DOM target coordinates. This overlay is
        // only a viewer aid and cannot receive clicks or affect hit testing.
        addEventListener('DOMContentLoaded',()=>{
          const cursor=document.createElement('div');cursor.id='relay-controller-cursor';cursor.setAttribute('aria-hidden','true');
          Object.assign(cursor.style,{position:'fixed',width:'16px',height:'16px',border:'2px solid #dc2626',borderRadius:'50%',pointerEvents:'none',zIndex:'2147483647',display:'none',transform:'translate(-50%, -50%)'});document.body.append(cursor);
          addEventListener('mousemove',event=>{cursor.style.left=event.clientX+'px';cursor.style.top=event.clientY+'px';cursor.style.display='block';});
        },{once:true});
      },{origin:RELAY_ORIGIN,base:RELAY_BACKEND,token:initialSession.token,expiresAt:initialSession.expiresAt});
      await context.route('**/*',async route=>{
        try{
          const session=await freshSession(),request=route.request();
          // CORS preflight is fulfilled locally; it never grants an action or
          // sends a request to a second origin. Actual POST still validates the
          // exact read payload, token, worker identity, and live delegation.
          if(request.url()===RELAY_BACKEND&&request.method()==='OPTIONS'&&!request.isNavigationRequest()&&['fetch','xhr','other'].includes(request.resourceType())&&!request.redirectedFrom()){
            const h=request.headers(),wanted=(h['access-control-request-headers']||'').split(',').map(x=>x.trim().toLowerCase()).sort();
            if(h.origin!==RELAY_ORIGIN||h['access-control-request-method']!=='POST'||wanted.length!==2||wanted[0]!=='authorization'||wanted[1]!=='content-type')return await route.abort('blockedbyclient');
            return await route.fulfill({status:204,headers:{'access-control-allow-origin':RELAY_ORIGIN,'access-control-allow-methods':'POST','access-control-allow-headers':'authorization, content-type','cache-control':'no-store'},body:''});
          }
          const asset=assetRequest(request),read=readRequest(request,session.token);
          if(!asset&&!read)return await route.abort('blockedbyclient');
          // fetch rather than continue: maxRedirects=0 prevents authorization
          // headers following a redirect before another route can inspect it.
          const response=await route.fetch({...(asset?{url:asset.url,headers:{accept:'*/*'}}:{headers:{'content-type':'application/json',authorization:`Bearer ${session.token}`},postData:read.body}),maxRedirects:0,maxRetries:0,timeout:10000});
          if(response.status()>=300&&response.status()<400)return await route.abort('blockedbyclient');
          await freshSession();
          const body=await response.body();if(body.byteLength>4_000_000)return await route.abort('blockedbyclient');
          const contentType=response.headers()['content-type']||'';
          if(read){
            if(!contentType.startsWith('application/json'))return await route.abort('blockedbyclient');
            const value=JSON.parse(body.toString('utf8'));
            if(response.status()===401||['SESSION','UNAUTHORIZED','STALE_SESSION','DELETED'].includes(value?.error?.code)){revoked=true;await route.abort('blockedbyclient');void closeDriver().catch(()=>{});return;}
            if(response.status()===200){try{if(read.action==='context')checkedContext(value,binding);else checkedInbox(value,binding);}catch{revoked=true;await route.abort('blockedbyclient');void closeDriver().catch(()=>{});return;}}
          }else if(!({document:'text/html',script:'text/javascript',stylesheet:'text/css',image:'image/svg+xml'}[asset.type]&&contentType.startsWith({document:'text/html',script:'text/javascript',stylesheet:'text/css',image:'image/svg+xml'}[asset.type]))&&!(asset.type==='script'&&contentType.startsWith('application/javascript')))return await route.abort('blockedbyclient');
          const headers={'content-type':contentType,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
          if(read)headers['access-control-allow-origin']=RELAY_ORIGIN;
          if(asset?.type==='document')headers['content-security-policy']=`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ${RELAY_BACKEND}; font-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
          await route.fulfill({status:response.status(),headers,body});
        }catch{await route.abort('blockedbyclient').catch(()=>{});if(revoked)void closeDriver().catch(()=>{});}
      });
      await context.routeWebSocket('**/*',socket=>socket.close());
      for(const previous of context.pages())await previous.close();
      page=await context.newPage();context.on('page',popup=>{if(popup!==page)void popup.close().catch(()=>{});});
      page.on('dialog',dialog=>void dialog.dismiss().catch(()=>{}));page.on('download',download=>void download.cancel().catch(()=>{}));
      page.on('filechooser',chooser=>void chooser.setFiles([]).catch(()=>{}));
      await page.goto(RELAY_ORIGIN+'/',{waitUntil:'domcontentloaded',timeout:15000});
      await page.waitForFunction(()=>document.querySelector('#identity-role')?.textContent==='Worker'&&document.querySelector('#connection-text')?.textContent==='Signed in · Worker'&&document.querySelector('.shell')?.hidden===false,{},{timeout:15000});
      await assertPage();
      async function snapshot(){
        await assertPage();
        return page.evaluate(specs=>{
          const shell=document.querySelector('.shell'),auth=document.querySelector('#auth-screen'),modal=document.querySelector('#modal');
          const controls=specs.map(spec=>{
            const nodes=Array.from(document.querySelectorAll(spec.selector));
            return {key:spec.key,nodes:nodes.map(el=>({tag:el.tagName,href:el.getAttribute('href'),action:el.getAttribute('data-action'),dmAction:el.getAttribute('data-dm-action'),aria:el.getAttribute('aria-label'),label:(!spec.textLabel&&el.getAttribute('aria-label'))||el.querySelector('.nav-link-label')?.textContent||el.childNodes?.[0]?.textContent?.trim()||el.textContent?.trim()||'',disabled:el.disabled===true,visible:el.getClientRects().length>0,secret:!!el.closest('#auth-screen, #modal, [data-controller-mask]')}))};
          });
          return {route:location.hash.slice(1)||'room',worker:document.querySelector('#identity-role')?.textContent==='Worker',connected:document.querySelector('#connection-text')?.textContent==='Signed in · Worker',shellVisible:shell?.hidden===false,authHidden:auth?.hidden===true,modalOpen:modal?.open===true,controls};
        },SPECS);
      }
      function checkedSnapshot(value){
        if(!value.worker||!value.connected||!value.shellVisible||!value.authHidden||value.modalOpen||!['room','overview','inbox'].includes(value.route))fail('STALE_OBSERVATION');
        for(const entry of value.controls){const spec=SPECS.find(s=>s.key===entry.key);if(!spec||entry.nodes.length>1)fail('STALE_OBSERVATION');for(const node of entry.nodes)if(node.tag!==spec.tag||node.label!==spec.label||node.secret||(spec.href&&node.href!==spec.href)||(spec.action&&node.action!==spec.action)||(spec.dmAction&&node.dmAction!==spec.dmAction)||(spec.key==='inbox'&&!/^(Private messages|[0-9]{1,9} unread private messages)$/.test(node.aria||'')))fail('STALE_OBSERVATION');}
        return value;
      }
      async function checkedTarget(id){
        const target=targets.get(id);if(!target)fail('STALE_OBSERVATION');
        const current=checkedSnapshot(await snapshot());if(JSON.stringify(current)!==target.fingerprint)fail('STALE_OBSERVATION');
        const handles=await page.locator(target.spec.selector).elementHandles();
        try{if(handles.length!==1||!await target.handle.evaluate((el,current)=>el===current&&el.isConnected,handles[0]))fail('STALE_OBSERVATION');}finally{await Promise.all(handles.map(handle=>handle===target.handle?undefined:handle.dispose()));}
        if(!await target.handle.isVisible()||!await target.handle.isEnabled())fail('STALE_OBSERVATION');return target;
      }
      return {
        observe:protectedOperation(async()=>{
          await releaseTargets();const value=checkedSnapshot(await snapshot()),advertised=[];
          for(const spec of SPECS){const entry=value.controls.find(x=>x.key===spec.key),node=entry.nodes[0];if(!node||!node.visible||node.disabled)continue;
            const handles=await page.locator(spec.selector).elementHandles();if(handles.length!==1){await Promise.all(handles.map(handle=>handle.dispose()));fail('STALE_OBSERVATION');}
            const id='relay_'+randomUUID();targets.set(id,{spec,handle:handles[0],fingerprint:JSON.stringify(value)});advertised.push({id,role:spec.role,name:spec.name});
          }
          return {title:'Relay',status:`Worker browser · ${value.route==='room'?'My room':value.route==='inbox'?'Private inbox':'Overview'}`,targets:advertised};
        }),
        click:protectedOperation(async id=>{
          try{const target=await checkedTarget(id);await target.handle.scrollIntoViewIfNeeded();const box=await target.handle.boundingBox();if(!box)fail('STALE_OBSERVATION');await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await checkedTarget(id);await target.handle.click({timeout:3000});if(target.spec.href)await page.waitForFunction(hash=>location.hash===hash&&document.querySelector('#identity-role')?.textContent==='Worker',target.spec.href,{timeout:3000});await assertPage();}
          finally{await releaseTargets();}
        }),
        fill:protectedOperation(async()=>{await freshSession();fail('FORBIDDEN');}),
        screenshot:protectedOperation(async()=>{
          await snapshot().then(checkedSnapshot);
          const image=await page.screenshot({type:'png',fullPage:false,mask:[page.locator('#content, #modal, #auth-screen, #toast, .owner, .project-switch, input, textarea, select, [contenteditable], [data-controller-mask]')],maskColor:'#111827'});
          await assertPage();return {mimeType:'image/png',data:image.toString('base64')};
        }),
        async close(){try{await closeDriver();}catch(error){throw safeError(error);}}
      };
    }catch(error){await closeDriver().catch(()=>{/* Quarantine until the host confirms actual process teardown. */});throw safeError(error);}
  };
}
