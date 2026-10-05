import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,symlink,mkdir,chmod} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {createFixtureDriverFactory,FIXTURE_URL} from '../playwright-driver.mjs';

// Mocked Chromium policy only. No real browser, real account, or network traffic.
const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const AGENT='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET='fixture-password-must-not-appear';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWJ8AAAAASUVORK5CYII=','base64');
const authority=(accountId=A,workspaceId='fixture-workspace',runId='run-fixture')=>({workspaceId,accountId,agentId:AGENT,runId});

function mockChromium(options={}) {
  const launches=[],contexts=[],ledger=[];
  class Element {
    constructor(key,tag,type,name){this.key=key;this.tagName=tag;this.type=type;this.name=name;this.value=SECRET;this.disabled=false;this.secret=false;this.isConnected=true;this.visible=true;}
    getAttribute(name){return {'data-controller-target':this.key,type:this.type,'aria-label':this.name}[name]??null;}
    get textContent(){return this.tagName==='BUTTON'?this.name:'';}
    closest(){return this.secret?{}:null;}
  }
  class Handle {
    constructor(page,element){this.page=page;this.element=element;this.disposed=false;}
    async evaluate(fn,other){return fn(this.element,other?.element??other);}
    async isVisible(){return this.element.visible;}
    async isEnabled(){return !this.element.disabled;}
    async dispose(){this.disposed=true;ledger.push('dispose');}
    async scrollIntoViewIfNeeded(){ledger.push('scroll');}
    async boundingBox(){return {x:10,y:20,width:80,height:40};}
    async click(config){ledger.push(['click',this.element.key,config]);this.page.saved++;this.page.status=`Saved ${this.page.saved} test note(s).`;}
    async fill(value,config){ledger.push(['fill',this.element.key,value,config]);this.element.value=value;}
  }
  class Page {
    constructor(prior=false){this.handlers=new Map();this.closed=false;this.currentURL=prior?'https://old.invalid/':'about:blank';this.title='Relay browser test';this.status='Waiting';this.saved=0;this.screenshots=[];this.controls=[new Element('note','INPUT','text','Test note'),new Element('save','BUTTON','button','Save test note')];this.mouse={move:async(x,y)=>ledger.push(['move',x,y])};}
    on(name,handler){this.handlers.set(name,handler);}
    isClosed(){return this.closed;}
    url(){return this.currentURL;}
    async close(){this.closed=true;ledger.push('page-close');}
    async goto(url,config){this.currentURL=url;this.navigation={url,config};}
    async evaluate(fn){
      const document={title:this.title,querySelectorAll:()=>this.controls,querySelector:()=>({textContent:this.status,value:SECRET})};
      // Execute the trusted driver's exact snapshot callback against a small DOM.
      return runInNewContext(`(${fn.toString()})()`,{document});
    }
    locator(selector){
      const page=this;return {selector,async elementHandles(){const match=selector.match(/^\[data-controller-target="([a-z]+)"\]$/);return match?page.controls.filter(value=>value.key===match[1]).map(value=>new Handle(page,value)):[];}};
    }
    async screenshot(config){this.screenshots.push(config);return PNG;}
  }
  class Context {
    constructor(){this.handlers=new Map();this.prior=new Page(true);this.page=new Page();this.closed=false;this.closeAttempts=0;this.failClose=options.failClose??false;this.pagesCreated=0;}
    setDefaultTimeout(value){this.defaultTimeout=value;}
    async clearPermissions(){this.permissionsCleared=true;}
    async route(pattern,handler){if(options.setupError)throw new Error('mock setup failure');this.routePattern=pattern;this.routeHandler=handler;}
    async routeWebSocket(pattern,handler){this.socketPattern=pattern;this.socketHandler=handler;}
    pages(){return [this.prior];}
    async newPage(){this.pagesCreated++;return this.page;}
    on(name,handler){this.handlers.set(name,handler);}
    async close(){this.closeAttempts++;if(this.failClose)throw new Error('mock teardown failure');this.closed=true;}
  }
  const chromium={async launchPersistentContext(profile,config){launches.push({profile,config});if(options.launchError)throw new Error('mock launch failure');const context=new Context();contexts.push(context);return context;}};
  return {chromium,launches,contexts,ledger};
}

async function setup(t,options={}) {
  const root=await mkdtemp(join(tmpdir(),'relay-driver-policy-'));
  const mock=mockChromium(options);
  t.after(async()=>{for(const context of mock.contexts){context.failClose=false;await context.close();}await rm(root,{recursive:true,force:true});});
  const factory=createFixtureDriverFactory({profileRoot:root,chromium:mock.chromium});
  return {root,mock,factory};
}
async function routed(context,request={}){
  const outcome={};
  await context.routeHandler({request:()=>({url:()=>request.url??FIXTURE_URL,method:()=>request.method??'GET',isNavigationRequest:()=>request.navigation??true,resourceType:()=>request.type??'document'}),fulfill:async value=>{outcome.fulfilled=value;},abort:async reason=>{outcome.aborted=reason;}});
  return outcome;
}

test('persistent profiles are opaque, private, and derive only from trusted workspace/account',async t=>{
  const {root,mock,factory}=await setup(t);const first=await factory({binding:authority()}),second=await factory({binding:authority(B)});
  assert.equal(mock.launches.length,2);assert.notEqual(mock.launches[0].profile,mock.launches[1].profile);
  for(const launch of mock.launches){assert.equal(dirname(launch.profile),root);assert.match(launch.profile.slice(root.length+1),/^[a-f0-9]{64}$/);assert.equal((await stat(launch.profile)).mode&0o777,0o700);assert.ok(!launch.profile.includes(A));}
  assert.equal((await stat(root)).mode&0o777,0o700);
  await first.close();await second.close();
});

test('same account is isolated across workspaces but can reuse its persistent profile after confirmed close',async t=>{
  const {mock,factory}=await setup(t);const first=await factory({binding:authority()});
  await assert.rejects(factory({binding:authority()}),error=>error.code==='LIMIT');
  const other=await factory({binding:authority(A,'another-workspace')});
  assert.notEqual(mock.launches[0].profile,mock.launches[1].profile);
  await first.close();const replacement=await factory({binding:authority(A,'fixture-workspace','replacement-run')});
  assert.equal(mock.launches[0].profile,mock.launches[2].profile);await replacement.close();await other.close();
});

test('launch keeps the Chromium sandbox, denies downloads/service workers, and clears permissions',async t=>{
  const {mock,factory}=await setup(t);const driver=await factory({binding:authority()});const launch=mock.launches[0],context=mock.contexts[0];
  assert.equal(launch.config.chromiumSandbox,true);assert.equal(launch.config.acceptDownloads,false);assert.equal(launch.config.serviceWorkers,'block');assert.deepEqual(launch.config.permissions,[]);assert.equal(launch.config.headless,true);assert.deepEqual(launch.config.viewport,{width:1280,height:720});
  assert.ok(!JSON.stringify(launch.config).includes('--no-sandbox'));assert.equal(context.permissionsCleared,true);assert.equal(context.defaultTimeout,3000);
  await driver.close();
});

test('only the exact fixture GET document navigation is fulfilled locally with restrictive CSP',async t=>{
  const {mock,factory}=await setup(t);const driver=await factory({binding:authority()});const context=mock.contexts[0];
  assert.equal(context.routePattern,'**/*');const outcome=await routed(context);
  assert.equal(outcome.fulfilled.status,200);assert.equal(outcome.aborted,undefined);assert.match(outcome.fulfilled.body,/<title>Relay browser test<\/title>/);
  const csp=outcome.fulfilled.headers['content-security-policy'];for(const directive of ["default-src 'none'","connect-src 'none'","frame-src 'none'","form-action 'none'","base-uri 'none'"])assert.ok(csp.includes(directive));
  assert.equal(outcome.fulfilled.headers['cache-control'],'no-store');await driver.close();
});

test('route policy blocks external/private/file URLs, lookalikes, credentials, redirects, and subresources',async t=>{
  const {mock,factory}=await setup(t);const driver=await factory({binding:authority()});const context=mock.contexts[0];
  for(const url of ['https://external.example/','http://127.0.0.1/','http://169.254.169.254/','file:///etc/passwd','https://relay-fixture.invalid.evil/','https://relay-fixture.invalid/?secret=x','https://user:password@relay-fixture.invalid/','https://relay-fixture.invalid/redirect']){const outcome=await routed(context,{url});assert.equal(outcome.aborted,'blockedbyclient');assert.equal(outcome.fulfilled,undefined);}
  for(const request of [{method:'POST'},{navigation:false},{type:'script'},{type:'image'},{type:'fetch'},{type:'websocket'}])assert.equal((await routed(context,request)).aborted,'blockedbyclient');
  await driver.close();
});

test('WebSockets are closed without server connection and unexpected pages/dialogs/downloads are canceled',async t=>{
  const {mock,factory}=await setup(t);const driver=await factory({binding:authority()}),context=mock.contexts[0];
  assert.equal(context.socketPattern,'**/*');let socketClosed=false,connected=false;
  await context.socketHandler({close:()=>{socketClosed=true;},connectToServer:()=>{connected=true;}});assert.equal(socketClosed,true);assert.equal(connected,false);
  let popupClosed=false,dismissed=false,canceled=false;
  context.handlers.get('page')({close:async()=>{popupClosed=true;}});
  context.page.handlers.get('dialog')({dismiss:async()=>{dismissed=true;}});
  context.page.handlers.get('download')({cancel:async()=>{canceled=true;}});await Promise.resolve();
  assert.equal(popupClosed,true);assert.equal(dismissed,true);assert.equal(canceled,true);await driver.close();
});

test('old persistent pages are closed rather than reattached and only the fixture is opened',async t=>{
  const {mock,factory}=await setup(t);const driver=await factory({binding:authority()}),context=mock.contexts[0];
  assert.equal(context.prior.closed,true);assert.equal(context.pagesCreated,1);assert.equal(context.page.navigation.url,FIXTURE_URL);assert.equal(context.page.navigation.config.waitUntil,'domcontentloaded');await driver.close();
});

test('observations are bounded fixed control DTOs and do not expose input values or form secrets',async t=>{
  const {mock,factory}=await setup(t);const driver=await factory({binding:authority()}),value=await driver.observe();
  assert.deepEqual(Object.keys(value).sort(),['status','targets','title']);assert.equal(value.title,'Relay browser test');assert.equal(value.status,'Waiting');assert.equal(value.targets.length,2);
  assert.deepEqual(value.targets.map(target=>({role:target.role,name:target.name})),[{role:'textbox',name:'Test note'},{role:'button',name:'Save test note'}]);
  for(const target of value.targets)assert.deepEqual(Object.keys(target).sort(),['id','name','role']);assert.ok(!JSON.stringify(value).includes(SECRET));assert.equal(mock.contexts[0].page.controls[0].value,SECRET);await driver.close();
});

test('changed, disabled, secret, or injected controls are never advertised as safe targets',async t=>{
  const {mock,factory}=await setup(t);const driver=await factory({binding:authority()}),page=mock.contexts[0].page;
  page.controls[0].secret=true;await assert.rejects(driver.observe(),error=>error.code==='STALE_OBSERVATION');page.controls[0].secret=false;
  page.controls[0].disabled=true;await assert.rejects(driver.observe(),error=>error.code==='STALE_OBSERVATION');page.controls[0].disabled=false;
  page.controls[0].type='password';await assert.rejects(driver.observe(),error=>error.code==='STALE_OBSERVATION');page.controls[0].type='text';
  page.controls[0].name=SECRET;await assert.rejects(driver.observe(),error=>error.code==='STALE_OBSERVATION');page.controls[0].name='Test note';
  page.status=SECRET;await assert.rejects(driver.observe(),error=>error.code==='STALE_OBSERVATION');page.status='Waiting';
  page.controls.push(page.controls[0]);await assert.rejects(driver.observe(),error=>error.code==='STALE_OBSERVATION');await driver.close();
});

test('direct actions move the cursor to actual element coordinates and dispose stale handles',async t=>{
  const {mock,factory}=await setup(t);const driver=await factory({binding:authority()}),observation=await driver.observe();const note=observation.targets.find(target=>target.role==='textbox');
  await driver.fill(note.id,'Literal <script>input</script>');assert.equal(mock.contexts[0].page.controls[0].value,'Literal <script>input</script>');
  assert.ok(mock.ledger.some(value=>Array.isArray(value)&&value[0]==='move'&&value[1]===50&&value[2]===40));assert.ok(mock.ledger.some(value=>Array.isArray(value)&&value[0]==='fill'));
  await assert.rejects(driver.fill(note.id,'Blind retry'),error=>error.code==='STALE_OBSERVATION');
  const fresh=await driver.observe(),button=fresh.targets.find(target=>target.role==='button');await driver.click(button.id);
  assert.equal((await driver.observe()).status,'Saved 1 test note(s).');await driver.close();
});

test('identical-markup DOM node replacement and changed snapshots invalidate previously observed handles',async t=>{
  const {mock,factory}=await setup(t);const driver=await factory({binding:authority()}),page=mock.contexts[0].page,observation=await driver.observe();
  const target=observation.targets.find(value=>value.role==='textbox'),old=page.controls[0];old.isConnected=false;page.controls[0]=Object.assign(Object.create(Object.getPrototypeOf(old)),old,{isConnected:true});
  await assert.rejects(driver.fill(target.id,'Must not act'),error=>error.code==='STALE_OBSERVATION');
  const fresh=await driver.observe();page.status='Saved 5 test note(s).';await assert.rejects(driver.click(fresh.targets.find(value=>value.role==='button').id),error=>error.code==='STALE_OBSERVATION');await driver.close();
});

test('screenshots explicitly mask every editable field and secret area, never full-page capture',async t=>{
  const {mock,factory}=await setup(t);const driver=await factory({binding:authority()}),image=await driver.screenshot(),options=mock.contexts[0].page.screenshots[0];
  assert.deepEqual(Object.keys(image).sort(),['data','mimeType']);assert.equal(image.mimeType,'image/png');assert.deepEqual(Buffer.from(image.data,'base64'),PNG);assert.equal(options.type,'png');assert.equal(options.fullPage,false);assert.equal(options.maskColor,'#111827');
  assert.deepEqual(options.mask.map(locator=>locator.selector),['input, textarea, [contenteditable], [data-controller-mask]']);await driver.close();
});

test('unexpected navigation or a closed page prevents observation, actions, and screenshots',async t=>{
  const {mock,factory}=await setup(t);const driver=await factory({binding:authority()}),page=mock.contexts[0].page,observation=await driver.observe();page.currentURL='https://external.example/';
  for(const call of [()=>driver.observe(),()=>driver.click(observation.targets[1].id),()=>driver.screenshot()])await assert.rejects(call(),error=>error.code==='STALE_OBSERVATION');page.currentURL=FIXTURE_URL;page.closed=true;
  await assert.rejects(driver.screenshot(),error=>error.code==='STALE_OBSERVATION');await driver.close();
});

test('failed launch releases only its unused reservation and allows safe later startup',async t=>{
  const {root}=await setup(t),failing=mockChromium({launchError:true});let fail=true;const good=mockChromium();
  const chromium={launchPersistentContext:async(...args)=>(fail?failing:good).chromium.launchPersistentContext(...args)};
  const factory=createFixtureDriverFactory({profileRoot:root,chromium});await assert.rejects(factory({binding:authority()}));fail=false;
  const driver=await factory({binding:authority()});await driver.close();assert.equal(good.launches.length,1);
});

test('failed browser teardown quarantines its profile until a confirmed teardown retry',async t=>{
  const {mock,factory}=await setup(t,{failClose:true});const driver=await factory({binding:authority()});
  await assert.rejects(driver.close());await assert.rejects(factory({binding:authority()}),error=>error.code==='LIMIT');assert.equal(mock.launches.length,1);
  mock.contexts[0].failClose=false;await driver.close();assert.equal(mock.contexts[0].closed,true);
  const replacement=await factory({binding:authority()});mock.contexts[1].failClose=false;await replacement.close();assert.equal(mock.launches.length,2);
});

test('failed startup cleanup retains quarantine instead of silently reusing an orphan profile',async t=>{
  const {mock,factory}=await setup(t,{setupError:true,failClose:true});await assert.rejects(factory({binding:authority()}));
  assert.equal(mock.contexts[0].closed,false);await assert.rejects(factory({binding:authority()}),error=>error.code==='LIMIT');assert.equal(mock.launches.length,1);
});

test('profile root aliases for filesystem root are rejected before filesystem mutation',()=>{
  const mock=mockChromium();for(const profileRoot of ['/','/.','/tmp/..','//'])assert.throws(()=>createFixtureDriverFactory({profileRoot,chromium:mock.chromium}));assert.equal(mock.launches.length,0);
});

test('a symlink profile root is rejected before Chromium launch',async t=>{
  const {root,mock}=await setup(t);const target=join(root,'target'),link=join(root,'link');await mkdir(target,{mode:0o700});await symlink(target,link);
  const factory=createFixtureDriverFactory({profileRoot:link,chromium:mock.chromium});await assert.rejects(factory({binding:authority()}));assert.equal(mock.launches.length,0);
});

test('symlink ancestors are rejected instead of redirecting profile ownership',async t=>{
  const {root,mock}=await setup(t);const target=join(root,'target'),child=join(target,'child'),link=join(root,'link');await mkdir(target,{mode:0o700});await mkdir(child,{mode:0o700});await symlink(target,link);
  const factory=createFixtureDriverFactory({profileRoot:join(link,'child'),chromium:mock.chromium});await assert.rejects(factory({binding:authority()}));assert.equal(mock.launches.length,0);
});

test('insecure existing roots are rejected without changing their permissions',async t=>{
  const {root,mock}=await setup(t);await chmod(root,0o755);const factory=createFixtureDriverFactory({profileRoot:root,chromium:mock.chromium});await assert.rejects(factory({binding:authority()}));assert.equal((await stat(root)).mode&0o777,0o755);assert.equal(mock.launches.length,0);
});

test('invalid identity and relative/broad root configuration cannot launch a browser',async t=>{
  const {root,mock,factory}=await setup(t);
  for(const profileRoot of [null,'relative/path',''])assert.throws(()=>createFixtureDriverFactory({profileRoot,chromium:mock.chromium}));
  for(const value of [null,{},authority('not-account'),{...authority(),workspaceId:'../../escape'},{...authority(),runId:''},{...authority(),agentId:'manager'}])await assert.rejects(factory({binding:value}));
  assert.equal(mock.launches.length,0);assert.equal(dirname(root),tmpdir());
});
