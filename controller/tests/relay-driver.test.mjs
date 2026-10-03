import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,mkdir,symlink,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {createRelayDriverFactory,RELAY_ORIGIN,RELAY_BACKEND} from '../relay-driver.mjs';

// All accounts, page nodes, routes, and responses below are controlled mocks.
// These policy tests do not launch Chromium or access the live Relay website.
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',AGENT='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN='a'.repeat(64),SECRET='worker-private-dm-and-password-never-return';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWJ8AAAAASUVORK5CYII=','base64');
const binding=(accountId=A,workspaceId='test-workspace',runId='test-run')=>({workspaceId,accountId,agentId:AGENT,runId});
const session=b=>({binding:b,role:'worker',enabled:true,token:TOKEN,expiresAt:'2099-01-01T00:00:00.000Z',scopes:['browser:control']});
const contextDTO=b=>({user:{id:b.accountId,agentId:b.agentId,role:'worker',enabled:true,name:SECRET},actor:{id:b.agentId,owner:false,session:b.runId},state:{private:SECRET}});

function mockChromium({failClose=false,setupError=false}={}){
  const launches=[],contexts=[],ledger=[];
  class Element{
    constructor(key,tag,label,attributes={}){this.key=key;this.tagName=tag;this.label=label;this.attributes=attributes;this.visible=true;this.disabled=false;this.secret=false;this.isConnected=true;this.value=SECRET;this.childNodes=[{textContent:label}];}
    get textContent(){return this.label;}
    getAttribute(name){return this.attributes[name]??null;}
    querySelector(selector){return selector==='.nav-link-label'&&this.key!=='inbox'?{textContent:this.label}:null;}
    closest(){return this.secret?{}:null;}
    getClientRects(){return this.visible?[{}]:[];}
  }
  class Handle{
    constructor(page,el){this.page=page;this.el=el;this.disposed=false;}
    async evaluate(fn,other){return fn(this.el,other?.el??other);}
    async dispose(){this.disposed=true;ledger.push(['dispose',this.el.key]);}
    async isVisible(){return this.el.visible;}
    async isEnabled(){return !this.el.disabled;}
    async scrollIntoViewIfNeeded(){ledger.push('scroll');}
    async boundingBox(){return {x:20,y:30,width:80,height:40};}
    async click(options){ledger.push(['click',this.el.key,options]);if(this.el.attributes.href){this.page.hash=this.el.attributes.href;this.page.currentURL=RELAY_ORIGIN+'/'+this.page.hash;}}
  }
  class Page{
    constructor(prior=false){this.handlers=new Map();this.closed=false;this.currentURL=prior?'https://old.invalid/':'about:blank';this.hash='#room';this.worker=true;this.connected=true;this.authHidden=true;this.shellVisible=true;this.modalOpen=false;this.screenshots=[];this.mouse={move:async(...coordinates)=>ledger.push(['move',...coordinates])};
      this.nodes=new Map([
        ['#nav a.nav-item[href="#room"]',[new Element('room','A','My room',{href:'#room'})]],
        ['#nav a.nav-item[href="#overview"]',[new Element('overview','A','Overview',{href:'#overview'})]],
        ['#dm-notification[href="#inbox"]',[new Element('inbox','A','Inbox',{href:'#inbox','aria-label':'Private messages'})]],
        ['button[data-action="refresh"][aria-label="Refresh board"]',[new Element('refresh','BUTTON','Refresh board',{'data-action':'refresh','aria-label':'Refresh board'})]],
        ['#dm-root button[data-dm-action="refresh"]',[]]
      ]);
    }
    on(event,handler){this.handlers.set(event,handler);}
    isClosed(){return this.closed;}
    url(){return this.currentURL;}
    async close(){this.closed=true;}
    async goto(url,options){this.currentURL=url+'#room';this.navigation={url,options};}
    dom(){const page=this;return {querySelectorAll:selector=>page.nodes.get(selector)||[],querySelector:selector=>({'.shell':{hidden:!page.shellVisible},'#auth-screen':{hidden:page.authHidden},'#modal':{open:page.modalOpen},'#identity-role':{textContent:page.worker?'Worker':'Studio manager'},'#connection-text':{textContent:page.connected?'Signed in · Worker':'Connection needs attention'}}[selector]||null)};}
    async evaluate(fn,arg){return runInNewContext(`(${fn.toString()})(arg)`,{document:this.dom(),location:{hash:this.hash},arg});}
    async waitForFunction(fn,arg,options){assert.equal(await this.evaluate(fn,arg),true);this.waitOptions=options;}
    locator(selector){const page=this;return {selector,async elementHandles(){return (page.nodes.get(selector)||[]).map(el=>new Handle(page,el));}};}
    async screenshot(options){this.screenshots.push(options);return PNG;}
  }
  class Context{
    constructor(){this.prior=new Page(true);this.page=new Page();this.handlers=new Map();this.closed=false;this.failClose=failClose;this.init=[];}
    setDefaultTimeout(value){this.timeout=value;}
    async clearPermissions(){this.clearedPermissions=true;}
    async clearCookies(){this.clearedCookies=true;}
    async addInitScript(fn,arg){this.init.push({fn,arg});}
    async route(pattern,handler){if(setupError)throw new Error(SECRET);this.routePattern=pattern;this.routeHandler=handler;}
    async routeWebSocket(pattern,handler){this.socketPattern=pattern;this.socketHandler=handler;}
    pages(){return [this.prior];}
    async newPage(){return this.page;}
    on(event,handler){this.handlers.set(event,handler);}
    async close(){if(this.failClose)throw new Error(SECRET);this.closed=true;}
  }
  const chromium={async launchPersistentContext(profile,options){launches.push({profile,options});const ctx=new Context();contexts.push(ctx);return ctx;}};
  return {chromium,launches,contexts,ledger};
}
async function setup(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'relay-real-driver-policy-')),mock=mockChromium(options);
  let authority=session(binding()),calls=0;
  const resolver=async b=>{calls++;if(authority instanceof Error)throw authority;return {...authority,binding:authority?.binding??b};};
  const factory=createRelayDriverFactory({profileRoot:root,resolveWorkerSession:resolver,chromium:mock.chromium});
  t.after(async()=>{for(const ctx of mock.contexts){ctx.failClose=false;await ctx.close();}await rm(root,{recursive:true,force:true});});
  return {root,mock,factory,setSession:v=>{authority=v;},resolverCalls:()=>calls};
}
async function routed(ctx,config={}){
  const outcome={};const body=config.body??JSON.stringify(contextDTO(binding()));
  const request={url:()=>config.url??RELAY_BACKEND,method:()=>config.method??'POST',resourceType:()=>config.type??'fetch',isNavigationRequest:()=>config.navigation??false,redirectedFrom:()=>config.redirected??null,headers:()=>config.headers??{'content-type':'application/json',authorization:`Bearer ${TOKEN}`},postData:()=>config.postData??JSON.stringify({action:'context',data:{}})};
  const response={status:()=>config.status??200,headers:()=>config.responseHeaders??{'content-type':'application/json','set-cookie':SECRET},body:async()=>Buffer.isBuffer(body)?body:Buffer.from(body)};
  await ctx.routeHandler({request:()=>request,fetch:async options=>{outcome.fetch=options;if(config.fetchError)throw new Error(SECRET);return response;},fulfill:async value=>{outcome.fulfilled=value;},abort:async reason=>{outcome.aborted=reason;}});
  return outcome;
}
const errorCode=code=>error=>error.code===code&&!error.message.includes(SECRET);

test('Relay driver derives isolated canonical private profiles and never accepts browser configuration from a model',async t=>{
  const s=await setup(t),first=await s.factory({binding:binding()});s.setSession(session(binding(B)));const second=await s.factory({binding:binding(B)});
  assert.notEqual(s.mock.launches[0].profile,s.mock.launches[1].profile);
  for(const launch of s.mock.launches){assert.equal(dirname(launch.profile),s.root);assert.match(launch.profile.slice(s.root.length+1),/^[a-f0-9]{64}$/);assert.equal((await stat(launch.profile)).mode&0o777,0o700);assert.equal(launch.profile.includes(A),false);}
  await first.close();await second.close();
});
test('real worker session must have browser delegation, matching binding, valid token and expiry before launch',async t=>{
  const s=await setup(t);
  for(const invalid of [{...session(binding()),role:'manager'},{...session(binding()),enabled:false},{...session(binding()),scopes:['relay:read']},{...session(binding()),token:'bad'},{...session(binding()),expiresAt:'2000-01-01'},{...session(binding()),binding:binding(B)},{...session(binding()),binding:{...binding(),runId:'another-run'}}]){
    s.setSession(invalid);await assert.rejects(s.factory({binding:binding()}));
  }
  assert.equal(s.mock.launches.length,0);
});
test('Chromium retains sandbox and clears previous permissions/cookies instead of importing old account authority',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),launch=s.mock.launches[0],ctx=s.mock.contexts[0];
  assert.equal(launch.options.chromiumSandbox,true);assert.equal(launch.options.acceptDownloads,false);assert.equal(launch.options.serviceWorkers,'block');assert.deepEqual(launch.options.permissions,[]);assert.ok(!JSON.stringify(launch.options).includes('--no-sandbox'));
  assert.equal(ctx.clearedPermissions,true);assert.equal(ctx.clearedCookies,true);assert.equal(ctx.prior.closed,true);assert.equal(ctx.page.navigation.url,RELAY_ORIGIN+'/');await driver.close();
});
test('trusted init clears old storage and seeds only the host-authorized worker session at the exact Relay origin',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),init=s.mock.contexts[0].init[0];const store=new Map();let cleared=0,registered=0;
  const localStorage={clear(){cleared++;}},sessionStorage={clear(){cleared++;store.clear();},setItem(k,v){store.set(k,v);}};
  runInNewContext(`(${init.fn.toString()})(arg)`,{arg:init.arg,location:{origin:RELAY_ORIGIN},localStorage,sessionStorage,addEventListener:()=>registered++});
  assert.equal(cleared,2);assert.equal(store.size,1);assert.deepEqual(JSON.parse(store.get('relay-account-session-v2')),{base:RELAY_BACKEND,token:TOKEN,expiresAt:init.arg.expiresAt});assert.equal(registered,1);
  store.clear();cleared=0;runInNewContext(`(${init.fn.toString()})(arg)`,{arg:init.arg,location:{origin:'https://elsewhere.invalid'},localStorage,sessionStorage});assert.equal(cleared,0);assert.equal(store.size,0);await driver.close();
});
test('only known HTTPS static assets are fetched, with clean headers, stripped version query and redirects disabled',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),ctx=s.mock.contexts[0];
  for(const [path,type,mime] of [['/','document','text/html'],['/app.mjs?v=reviewed-123','script','text/javascript'],['/style.css?v=123','stylesheet','text/css'],['/favicon.svg','image','image/svg+xml']]){
    const out=await routed(ctx,{url:RELAY_ORIGIN+path,method:'GET',type,navigation:type==='document',responseHeaders:{'content-type':mime,'set-cookie':SECRET},body:'controlled fixture bytes'});
    assert.equal(out.fetch.maxRedirects,0);assert.equal(out.fetch.maxRetries,0);assert.deepEqual(out.fetch.headers,{accept:'*/*'});assert.equal(out.fetch.url.includes('?'),false);assert.equal(out.fulfilled.status,200);assert.equal(out.fulfilled.headers['set-cookie'],undefined);
    if(type==='document')for(const expected of ["frame-src 'none'","form-action 'none'","worker-src 'none'",`connect-src ${RELAY_BACKEND}`])assert.ok(out.fulfilled.headers['content-security-policy'].includes(expected));
  }
  await driver.close();
});
test('private/external/file/lookalike hosts, arbitrary files, unexpected types, navigation queries and redirects cannot reach the network',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),ctx=s.mock.contexts[0];
  for(const url of ['https://other.invalid/','http://127.0.0.1/','http://169.254.169.254/','file:///etc/passwd',RELAY_ORIGIN+'.evil/',RELAY_ORIGIN+'/backend/handler.mjs',RELAY_ORIGIN+'/app.mjs?token='+TOKEN,RELAY_ORIGIN+'/?v=123','https://u:p@doublekingwasabi1819-a11y.github.io/']){
    const out=await routed(ctx,{url,method:'GET',type:'document',navigation:true});assert.equal(out.aborted,'blockedbyclient');assert.equal(out.fetch,undefined);
  }
  for(const extra of [{redirected:{}},{type:'image'},{method:'POST'},{navigation:false}]){const out=await routed(ctx,{url:RELAY_ORIGIN+'/',method:'GET',type:'document',navigation:true,...extra});assert.equal(out.fetch,undefined);}
  const redirected=await routed(ctx,{url:RELAY_ORIGIN+'/',method:'GET',type:'document',navigation:true,status:302,responseHeaders:{'content-type':'text/html',location:'http://127.0.0.1/'}});assert.equal(redirected.aborted,'blockedbyclient');assert.equal(redirected.fulfilled,undefined);await driver.close();
});
test('exact backend read payloads are forwarded with current token and zero redirects or retries',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),ctx=s.mock.contexts[0];
  for(const action of ['context','dm.inbox']){const out=await routed(ctx,{postData:JSON.stringify({action,data:{}}),...(action==='dm.inbox'?{body:JSON.stringify({contacts:[],threads:[],unreadCount:0})}:{})});assert.equal(out.fetch.maxRedirects,0);assert.equal(out.fetch.maxRetries,0);assert.deepEqual(out.fetch.headers,{'content-type':'application/json',authorization:`Bearer ${TOKEN}`});assert.equal(out.fetch.postData,JSON.stringify({action,data:{}}));assert.equal(out.fulfilled.headers['access-control-allow-origin'],RELAY_ORIGIN);assert.equal(out.fulfilled.headers['set-cookie'],undefined);}
  await driver.close();
});
test('backend send/read-marking/login/update/mutations and account selectors are denied even if DOM scripts request them',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),ctx=s.mock.contexts[0];
  for(const action of ['dm.send','dm.read','dm.thread','operation','login','logout','room.save','updates.list','updates.publish']){const out=await routed(ctx,{postData:JSON.stringify({action,data:{}})});assert.equal(out.aborted,'blockedbyclient');assert.equal(out.fetch,undefined);}
  for(const body of [{action:'context',data:{accountId:B}},{action:'context',data:{},extra:true},{action:'context',data:null},{action:'context',data:[]},{action:'dm.inbox',data:{beforeId:B}}])assert.equal((await routed(ctx,{postData:JSON.stringify(body)})).fetch,undefined);
  for(const request of [{url:RELAY_BACKEND+'?token='+TOKEN},{url:RELAY_BACKEND.replace('/relay','/relay-updates')},{headers:{'content-type':'application/json',authorization:'Bearer '+'b'.repeat(64)}},{headers:{'content-type':'application/json',authorization:`Bearer ${TOKEN}`,cookie:SECRET}},{navigation:true},{redirected:{}},{type:'document'},{postData:'not JSON'},{postData:' '.repeat(1025)}])assert.equal((await routed(ctx,request)).fetch,undefined);
  await driver.close();
});
test('CORS preflight is exact-origin, exact POST and exact-header allowlisted without network access',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),ctx=s.mock.contexts[0];
  const headers={origin:RELAY_ORIGIN,'access-control-request-method':'POST','access-control-request-headers':'authorization, content-type'};
  const out=await routed(ctx,{method:'OPTIONS',headers});assert.equal(out.fetch,undefined);assert.equal(out.fulfilled.status,204);assert.equal(out.fulfilled.headers['access-control-allow-origin'],RELAY_ORIGIN);
  for(const extra of [{origin:'https://evil.invalid'},{'access-control-request-method':'GET'},{'access-control-request-headers':'authorization, content-type, cookie'}])assert.equal((await routed(ctx,{method:'OPTIONS',headers:{...headers,...extra}})).aborted,'blockedbyclient');await driver.close();
});
test('wrong backend worker/account/agent/run response revokes access instead of rendering a manager or another worker',async t=>{
  for(const bad of [{...contextDTO(binding()),user:{...contextDTO(binding()).user,role:'manager'}},{...contextDTO(binding()),user:{...contextDTO(binding()).user,id:B}},{...contextDTO(binding()),actor:{...contextDTO(binding()).actor,owner:true}},{...contextDTO(binding()),actor:{...contextDTO(binding()).actor,session:'other-run'}}]){
    const s=await setup(t),driver=await s.factory({binding:binding()}),out=await routed(s.mock.contexts[0],{body:JSON.stringify(bad)});assert.equal(out.aborted,'blockedbyclient');assert.equal(out.fulfilled,undefined);await assert.rejects(driver.observe(),errorCode('AUTH_REQUIRED'));await driver.close();
  }
});
test('backend inbox responses cannot display a conversation between two other workers',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),ctx=s.mock.contexts[0];
  const other='33333333-3333-4333-8333-333333333333';
  const value={contacts:[],unreadCount:1,threads:[{participantA:B,participantB:other,unreadCount:1,lastMessage:{id:'44444444-4444-4444-8444-444444444444',senderId:B,recipientId:other,body:SECRET,createdAt:'2026-10-03T00:00:00Z',readAt:null}}]};
  const out=await routed(ctx,{postData:JSON.stringify({action:'dm.inbox',data:{}}),body:JSON.stringify(value)});assert.equal(out.aborted,'blockedbyclient');assert.equal(out.fulfilled,undefined);await assert.rejects(driver.observe(),errorCode('AUTH_REQUIRED'));await driver.close();
});
test('server session revocation, oversized responses, bad MIME and upstream failures produce no leaked errors or untrusted output',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),ctx=s.mock.contexts[0];
  for(const config of [{body:Buffer.alloc(4_000_001)},{responseHeaders:{'content-type':'text/html'}},{fetchError:true},{body:'invalid json'}]){const out=await routed(ctx,config);assert.equal(out.aborted,'blockedbyclient');assert.equal(out.fulfilled,undefined);}
  const out=await routed(ctx,{status:401,body:JSON.stringify({error:{code:'SESSION',message:SECRET}})});assert.equal(out.fulfilled,undefined);await assert.rejects(driver.screenshot(),errorCode('AUTH_REQUIRED'));assert.equal(ctx.closed,true);await driver.close();
});
test('bounded observations advertise static known controls without exposing page titles, private messages, identities or input values',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),obs=await driver.observe();
  assert.equal(obs.title,'Relay');assert.equal(obs.status,'Worker browser · My room');assert.deepEqual(obs.targets.map(x=>({name:x.name,role:x.role})),[{name:'My room',role:'link'},{name:'Overview',role:'link'},{name:'Private inbox',role:'link'},{name:'Refresh board',role:'button'}]);assert.equal(JSON.stringify(obs).includes(SECRET),false);assert.equal(JSON.stringify(obs).includes(TOKEN),false);
  for(const target of obs.targets)assert.deepEqual(Object.keys(target).sort(),['id','name','role']);await driver.close();
});
test('actual Relay Inbox aria labels support no unread messages and dynamic unread counts without returning the count or custom labels',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),node=s.mock.contexts[0].page.nodes.get('#dm-notification[href="#inbox"]')[0];
  for(const label of ['Private messages','1 unread private messages','124 unread private messages']){node.attributes['aria-label']=label;const obs=await driver.observe();assert.equal(obs.targets.find(x=>x.name==='Private inbox').name,'Private inbox');assert.equal(JSON.stringify(obs).includes(label),false);}
  node.attributes['aria-label']=SECRET;await assert.rejects(driver.observe(),errorCode('STALE_OBSERVATION'));await driver.close();
});
test('safe DOM actions move a real cursor and click only the same observed node, then release handles',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),obs=await driver.observe(),overview=obs.targets.find(x=>x.name==='Overview');await driver.click(overview.id);
  assert.ok(s.mock.ledger.some(x=>Array.isArray(x)&&x[0]==='move'&&x[1]===60&&x[2]===50));assert.ok(s.mock.ledger.some(x=>Array.isArray(x)&&x[0]==='click'&&x[1]==='overview'));assert.equal((await driver.observe()).status,'Worker browser · Overview');await assert.rejects(driver.click(overview.id),errorCode('STALE_OBSERVATION'));await driver.close();
});
test('identical markup replacements, route changes and hidden/disabled controls invalidate prior observations',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),page=s.mock.contexts[0].page,obs=await driver.observe(),target=obs.targets.find(x=>x.name==='Overview'),selector='#nav a.nav-item[href="#overview"]';
  const old=page.nodes.get(selector)[0];old.isConnected=false;page.nodes.set(selector,[Object.assign(Object.create(Object.getPrototypeOf(old)),old,{isConnected:true})]);await assert.rejects(driver.click(target.id),errorCode('STALE_OBSERVATION'));
  let fresh=await driver.observe();page.nodes.get(selector)[0].disabled=true;await assert.rejects(driver.click(fresh.targets.find(x=>x.name==='Overview').id),errorCode('STALE_OBSERVATION'));page.nodes.get(selector)[0].disabled=false;
  fresh=await driver.observe();page.hash='#inbox';page.currentURL=RELAY_ORIGIN+'/#inbox';await assert.rejects(driver.click(fresh.targets[0].id),errorCode('STALE_OBSERVATION'));await driver.close();
});
test('duplicate/injected/secret controls and authentication UI are rejected rather than promoted to actions',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),page=s.mock.contexts[0].page,selector='#nav a.nav-item[href="#room"]',node=page.nodes.get(selector)[0];
  node.label=SECRET;await assert.rejects(driver.observe(),errorCode('STALE_OBSERVATION'));node.label='My room';node.secret=true;await assert.rejects(driver.observe(),errorCode('STALE_OBSERVATION'));node.secret=false;page.nodes.set(selector,[node,node]);await assert.rejects(driver.observe(),errorCode('STALE_OBSERVATION'));page.nodes.set(selector,[node]);
  for(const property of ['worker','connected','authHidden','shellVisible']){page[property]=false;await assert.rejects(driver.observe(),errorCode('STALE_OBSERVATION'));page[property]=true;}page.modalOpen=true;await assert.rejects(driver.observe(),errorCode('STALE_OBSERVATION'));await driver.close();
});
test('fill is unavailable, including guessed DM or secret target IDs',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()});for(const target of ['private-message','password','room-notes'])await assert.rejects(driver.fill(target,SECRET),errorCode('FORBIDDEN'));assert.ok(!s.mock.ledger.some(x=>Array.isArray(x)&&x[0]==='fill'));await driver.close();
});
test('screenshots mask all workspace data, identities, dialogs, auth, toasts and editable areas',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),image=await driver.screenshot(),options=s.mock.contexts[0].page.screenshots[0];assert.equal(image.mimeType,'image/png');assert.deepEqual(Buffer.from(image.data,'base64'),PNG);assert.equal(options.fullPage,false);assert.equal(options.maskColor,'#111827');
  for(const selector of ['#content','#modal','#auth-screen','#toast','.owner','.project-switch','input','textarea','select','[contenteditable]','[data-controller-mask]'])assert.ok(options.mask[0].selector.includes(selector));await driver.close();
});
test('fresh trusted worker permission is checked on observations, screenshots, actions and routed requests',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),before=s.resolverCalls();await driver.observe();await driver.screenshot();await routed(s.mock.contexts[0]);assert.ok(s.resolverCalls()>before+3);
  s.setSession({...session(binding()),enabled:false});await assert.rejects(driver.observe(),errorCode('FORBIDDEN'));assert.equal(s.mock.contexts[0].closed,true);assert.equal((await routed(s.mock.contexts[0])).fetch,undefined);await driver.close();
});
test('token rotation cannot silently replace browser authority mid-session',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()});s.setSession({...session(binding()),token:'b'.repeat(64)});await assert.rejects(driver.observe(),errorCode('STALE_SESSION'));await driver.close();
});
test('popups/dialogs/downloads/files/WebSockets are closed or canceled without connection',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),ctx=s.mock.contexts[0];let popup=false,dialog=false,download=false,files,closed=false,connected=false;
  ctx.handlers.get('page')({close:async()=>{popup=true;}});ctx.page.handlers.get('dialog')({dismiss:async()=>{dialog=true;}});ctx.page.handlers.get('download')({cancel:async()=>{download=true;}});ctx.page.handlers.get('filechooser')({setFiles:async value=>{files=value;}});ctx.socketHandler({close:()=>{closed=true;},connectToServer:()=>{connected=true;}});await Promise.resolve();
  assert.equal(popup,true);assert.equal(dialog,true);assert.equal(download,true);assert.deepEqual(files,[]);assert.equal(closed,true);assert.equal(connected,false);await driver.close();
});
test('unexpected navigation, query/hash changes and closed pages block screenshots and observations',async t=>{
  const s=await setup(t),driver=await s.factory({binding:binding()}),page=s.mock.contexts[0].page;
  for(const url of ['file:///etc/passwd',RELAY_ORIGIN+'/?secret=x',RELAY_ORIGIN+'/#updates',RELAY_ORIGIN+'/index.html','https://other.invalid/']){page.currentURL=url;await assert.rejects(driver.observe(),errorCode('STALE_OBSERVATION'));await assert.rejects(driver.screenshot(),errorCode('STALE_OBSERVATION'));}page.currentURL=RELAY_ORIGIN+'/#room';page.closed=true;await assert.rejects(driver.observe(),errorCode('STALE_OBSERVATION'));await driver.close();
});
test('profile reuse requires confirmed teardown; a failed close quarantines only its account',async t=>{
  const s=await setup(t,{failClose:true}),driver=await s.factory({binding:binding()});await assert.rejects(driver.close());await assert.rejects(s.factory({binding:binding()}),errorCode('LIMIT'));s.mock.contexts[0].failClose=false;await driver.close();const replacement=await s.factory({binding:binding()});assert.equal(s.mock.launches[0].profile,s.mock.launches[1].profile);s.mock.contexts[1].failClose=false;await replacement.close();
});
test('a failed automatic revocation teardown quarantines the profile, normalizes close errors, and permits only confirmed cleanup retry',async t=>{
  const s=await setup(t,{failClose:true}),driver=await s.factory({binding:binding()});s.setSession({...session(binding()),enabled:false});await assert.rejects(driver.observe(),errorCode('FORBIDDEN'));assert.equal(s.mock.contexts[0].closed,false);
  s.setSession(session(binding()));await assert.rejects(s.factory({binding:binding()}),errorCode('LIMIT'));await assert.rejects(driver.close(),errorCode('INTERNAL'));s.mock.contexts[0].failClose=false;await driver.close();assert.equal(s.mock.contexts[0].closed,true);
  const replacement=await s.factory({binding:binding()});s.mock.contexts[1].failClose=false;await replacement.close();
});
test('startup teardown failure is quarantined and never exposes an upstream credential-bearing error',async t=>{
  const s=await setup(t,{setupError:true,failClose:true});await assert.rejects(s.factory({binding:binding()}),errorCode('INTERNAL'));await assert.rejects(s.factory({binding:binding()}),errorCode('LIMIT'));assert.equal(s.mock.launches.length,1);
});
test('broad/insecure/symlink profile roots and malformed bindings fail before launch without permission changes',async t=>{
  const s=await setup(t);for(const profileRoot of ['/','/tmp/..','relative',''])assert.throws(()=>createRelayDriverFactory({profileRoot,resolveWorkerSession:async()=>session(binding()),chromium:s.mock.chromium}));
  for(const value of [{},null,{...binding(),workspaceId:'../escape'},{...binding(),accountId:'manager'}])await assert.rejects(s.factory({binding:value}));assert.equal(s.mock.launches.length,0);
  await chmod(s.root,0o755);await assert.rejects(s.factory({binding:binding()}));assert.equal((await stat(s.root)).mode&0o777,0o755);await chmod(s.root,0o700);
  const target=join(s.root,'target'),link=join(s.root,'alias');await mkdir(target,{mode:0o700});await symlink(target,link);const factory=createRelayDriverFactory({profileRoot:link,resolveWorkerSession:async()=>session(binding()),chromium:s.mock.chromium});await assert.rejects(factory({binding:binding()}));assert.equal(s.mock.launches.length,0);
});
