import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserController} from '../core.mjs';

// Contract fixtures only: no browser, real account, network, or credentials.
const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const AGENT_A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENT_B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRIVATE='private-fixture-value-that-must-not-be-forwarded';
const alpha={connection:'alpha'},beta={connection:'beta'};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const binding=(accountId=A,agentId=AGENT_A,runId='run-alpha')=>({workspaceId:'fixture-workspace',accountId,agentId,runId});

function fixture(options={}) {
  const auth={alpha:binding(),beta:binding(B,AGENT_B,'run-beta')};
  const events=[],drivers=[],approvals=[],resolutions=[];
  let clock=1000,sequence=0;
  const authorize=async context=>{
    resolutions.push(context);
    if(options.authorize)return options.authorize(context,{auth,events,drivers});
    if(!auth[context?.connection])throw Object.assign(new Error(PRIVATE),{code:'SESSION'});
    return structuredClone(auth[context.connection]);
  };
  const authorizeAction=async(action,context)=>{
    approvals.push({action:structuredClone(action),context});
    return options.authorizeAction?options.authorizeAction(action,context,{auth,events,drivers}):true;
  };
  const createDriver=async({binding:identity})=>{
    events.push({operation:'create',accountId:identity.accountId});
    if(options.createDriver)return options.createDriver({binding:identity},{auth,events,drivers});
    const driver={binding:structuredClone(identity),closed:false,count:0,text:'',calls:[],
      async observe(){
        this.calls.push('observe');events.push({operation:'observe',accountId:identity.accountId});
        if(options.observe)return options.observe(this,{auth,events,drivers});
        return {title:'Isolated fixture',status:`Count ${this.count}; text ${this.text}`,targets:[{id:'increment',role:'button',name:'Increment',password:PRIVATE,value:PRIVATE,selector:PRIVATE},{id:'draft',role:'textbox',name:'Draft',password:PRIVATE,value:PRIVATE}],password:PRIVATE,storageState:PRIVATE,profilePath:PRIVATE};
      },
      async click(id){
        this.calls.push(['click',id]);events.push({operation:'click',accountId:identity.accountId,id});
        if(options.click)await options.click(this,id,{auth,events,drivers});
        this.count++;
      },
      async fill(id,text){
        this.calls.push(['fill',id,text]);events.push({operation:'fill',accountId:identity.accountId,id});
        if(options.fill)await options.fill(this,id,text,{auth,events,drivers});
        this.text=text;
      },
      async screenshot(){
        this.calls.push('screenshot');events.push({operation:'screenshot',accountId:identity.accountId});
        if(options.screenshot)return options.screenshot(this,{auth,events,drivers});
        return {mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWJ8AAAAASUVORK5CYII=',profilePath:PRIVATE,storageState:PRIVATE};
      },
      async close(){
        this.calls.push('close');events.push({operation:'close',accountId:identity.accountId});this.closed=true;
        if(options.close)await options.close(this,{auth,events,drivers});
      }
    };
    drivers.push(driver);return driver;
  };
  const config={authorize,createDriver,now:()=>clock,uuid:options.uuid??(()=>`fixture-id-${++sequence}`),maxSessions:options.maxSessions??8,observationTTL:options.observationTTL??60000};
  if(!options.noActionHook)config.authorizeAction=authorizeAction;
  const controller=createBrowserController(config);
  return {controller,auth,events,drivers,approvals,resolutions,setClock:value=>{clock=value;}};
}
const invoke=(f,name,args={},context=alpha)=>f.controller.callTool({name,arguments:args},context);
function success(result) {
  assert.notEqual(result.isError,true,JSON.stringify(result));
  assert.ok(result.structuredContent&&typeof result.structuredContent==='object');
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
  return result.structuredContent;
}
function failure(result,code) {
  assert.equal(result.isError,true,JSON.stringify(result));
  assert.equal(typeof result.structuredContent?.error?.code,'string');
  if(code)assert.equal(result.structuredContent.error.code,code);
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
  return result;
}
const open=async(f,context=alpha)=>success(await invoke(f,'browser_open',{},context));
const observed=async(f,session,context=alpha)=>success(await invoke(f,'browser_observe',{session_id:session.sessionId},context));
const reference=(session)=>({session_id:session.sessionId,observation_id:session.observation.id,target_id:'increment'});

test('open uses only trusted binding, narrowly allowlists output, and reuses its same-account session',async()=>{
  const f=fixture(),first=await open(f),second=await open(f);
  assert.equal(first.sessionId,second.sessionId);
  assert.equal(f.drivers.length,1);
  assert.deepEqual(f.drivers[0].binding,binding());
  assert.deepEqual(Object.keys(first).sort(),['observation','sessionId']);
  assert.deepEqual(Object.keys(first.observation).sort(),['id','status','targets','title']);
  for(const target of first.observation.targets)assert.deepEqual(Object.keys(target).sort(),['id','name','role']);
  assert.notEqual(first.observation.id,second.observation.id);
  assert.ok(f.resolutions.length>=4,'open must authorize before execution and before output');
  assert.deepEqual(f.approvals.map(value=>value.action.name),['browser_open','browser_open']);
});

test('different workers receive separate drivers, sessions, and observations',async()=>{
  const f=fixture();const [first,second]=await Promise.all([open(f),open(f,beta)]);
  assert.notEqual(first.sessionId,second.sessionId);assert.notEqual(first.observation.id,second.observation.id);
  assert.equal(f.drivers.length,2);
  assert.deepEqual(new Set(f.drivers.map(value=>value.binding.accountId)),new Set([A,B]));
  await invoke(f,'browser_fill',{...reference(first),target_id:'draft',text:'Alpha only'});
  assert.equal(f.drivers.find(value=>value.binding.accountId===B).text,'');
});

test('cross-worker session lookup rejects access without closing the other worker',async()=>{
  const f=fixture(),session=await open(f);
  failure(await invoke(f,'browser_observe',{session_id:session.sessionId},beta),'FORBIDDEN');
  failure(await invoke(f,'browser_click',reference(session),beta),'FORBIDDEN');
  failure(await invoke(f,'browser_close',{session_id:session.sessionId},beta),'FORBIDDEN');
  assert.equal(f.drivers[0].closed,false);assert.equal(f.drivers[0].count,0);
  success(await invoke(f,'browser_observe',{session_id:session.sessionId}));
});

test('workspace isolation also applies when accounts and runs otherwise match',async()=>{
  const f=fixture(),session=await open(f);f.auth.beta={...binding(),workspaceId:'other-workspace'};
  failure(await invoke(f,'browser_observe',{session_id:session.sessionId},beta),'FORBIDDEN');
  assert.equal(f.drivers[0].closed,false);
});

test('every mutating tool needs explicit action permission',async()=>{
  const f=fixture({noActionHook:true});
  failure(await invoke(f,'browser_open'),'FORBIDDEN');assert.equal(f.drivers.length,0);
});

test('an action-hook denial cannot create a browser or mutate an existing one',async()=>{
  let permitted=true;
  const f=fixture({authorizeAction:async()=>permitted});
  const session=await open(f);permitted=false;
  for(const [name,args] of [['browser_click',reference(session)],['browser_fill',{...reference(session),target_id:'draft',text:'Denied'}],['browser_close',{session_id:session.sessionId}]])failure(await invoke(f,name,args),'FORBIDDEN');
  assert.equal(f.drivers[0].closed,false);assert.equal(f.drivers[0].count,0);assert.equal(f.drivers[0].text,'');
  assert.equal(f.drivers[0].calls.filter(value=>Array.isArray(value)).length,0);
});

test('observe and screenshot do not reuse mutating action approval but still reauthorize',async()=>{
  const f=fixture(),session=await open(f);const before=f.resolutions.length;
  const observation=await observed(f,session);
  success(await invoke(f,'browser_screenshot',{session_id:session.sessionId,observation_id:observation.observation.id}));
  assert.ok(f.resolutions.length>=before+4);assert.equal(f.approvals.length,1);
});

test('successful click performs a real driver action and returns a new post-action observation',async()=>{
  const f=fixture(),session=await open(f),result=success(await invoke(f,'browser_click',reference(session)));
  assert.equal(f.drivers[0].count,1);assert.notEqual(result.observation.id,session.observation.id);
  assert.match(result.observation.status,/Count 1/);
  assert.deepEqual(f.drivers[0].calls.slice(-2),[['click','increment'],'observe']);
});

test('successful fill updates only a current textbox and observes afterward',async()=>{
  const f=fixture(),session=await open(f),result=success(await invoke(f,'browser_fill',{...reference(session),target_id:'draft',text:'Literal <script>untrusted</script>'}));
  assert.equal(f.drivers[0].text,'Literal <script>untrusted</script>');
  assert.notEqual(result.observation.id,session.observation.id);
  assert.deepEqual(f.drivers[0].calls.slice(-2),[['fill','draft','Literal <script>untrusted</script>'],'observe']);
});

test('fill rejects a current button target before invoking the driver',async()=>{
  const f=fixture(),session=await open(f);
  failure(await invoke(f,'browser_fill',{...reference(session),text:'Wrong role'}));
  assert.equal(f.drivers[0].text,'');assert.equal(f.drivers[0].calls.some(value=>Array.isArray(value)&&value[0]==='fill'),false);
});

test('unknown target and cross-session observation handles cannot select a DOM element',async()=>{
  const f=fixture(),first=await open(f),second=await open(f,beta);
  failure(await invoke(f,'browser_click',{...reference(first),target_id:'not-observed'}));
  failure(await invoke(f,'browser_click',{...reference(first),observation_id:second.observation.id}));
  assert.equal(f.drivers.find(value=>value.binding.accountId===A).count,0);
});

test('a fresh observation invalidates previous target references even without an action',async()=>{
  const f=fixture(),session=await open(f),fresh=await observed(f,session);
  assert.notEqual(session.observation.id,fresh.observation.id);
  failure(await invoke(f,'browser_click',reference(session)),'STALE_OBSERVATION');
  assert.equal(f.drivers[0].count,0);
});

test('a failed observation refresh invalidates old handles instead of permitting a stale action',async()=>{
  let failRefresh=false;
  const f=fixture({observe:async()=>{if(failRefresh)throw new Error(PRIVATE);return {title:'Fixture',status:'Ready',targets:[{id:'increment',role:'button',name:'Increment'}]};}}),session=await open(f);
  failRefresh=true;failure(await invoke(f,'browser_observe',{session_id:session.sessionId}),'INTERNAL');
  failure(await invoke(f,'browser_click',reference(session)),'STALE_OBSERVATION');assert.equal(f.drivers[0].count,0);
});

test('expired observations reject DOM actions and screenshots before driver access',async()=>{
  const f=fixture(),session=await open(f);f.setClock(61001);
  failure(await invoke(f,'browser_click',reference(session)),'STALE_OBSERVATION');
  failure(await invoke(f,'browser_screenshot',{session_id:session.sessionId,observation_id:session.observation.id}),'STALE_OBSERVATION');
  assert.equal(f.drivers[0].count,0);assert.equal(f.drivers[0].calls.includes('screenshot'),false);
});

test('run replacement quarantines and closes the current browser, then requires fresh open',async()=>{
  const f=fixture(),session=await open(f);f.auth.alpha.runId='replacement-run';
  failure(await invoke(f,'browser_observe',{session_id:session.sessionId}),'STALE_SESSION');
  assert.equal(f.drivers[0].closed,true);
  const replacement=await open(f);assert.notEqual(replacement.sessionId,session.sessionId);
  assert.equal(f.drivers.length,2);assert.equal(f.drivers[1].binding.runId,'replacement-run');
});

test('live authorization failure quarantines an already-open session and does not reveal its error',async()=>{
  const f=fixture(),session=await open(f);delete f.auth.alpha;
  failure(await invoke(f,'browser_observe',{session_id:session.sessionId}));
  assert.equal(f.drivers[0].closed,true);
});

test('queued actions recheck live authorization instead of relying on enqueue-time identity',async()=>{
  const entered=deferred(),release=deferred();
  const f=fixture({click:async()=>{entered.resolve();await release.promise;}}),session=await open(f);
  const first=invoke(f,'browser_click',reference(session));await entered.promise;
  const queued=invoke(f,'browser_fill',{...reference(session),target_id:'draft',text:'Must not run'});
  f.auth.alpha.runId='replacement-run';release.resolve();
  failure(await first);failure(await queued);
  assert.equal(f.drivers[0].closed,true);assert.equal(f.drivers[0].text,'');
});

test('post-action authorization rejects output if authority changes while the driver is running',async()=>{
  const entered=deferred(),release=deferred();
  const f=fixture({click:async()=>{entered.resolve();await release.promise;}}),session=await open(f);
  const pending=invoke(f,'browser_click',reference(session));await entered.promise;
  delete f.auth.alpha;release.resolve();failure(await pending);
  assert.equal(f.drivers[0].closed,true);
});

test('one worker queue is serialized while another worker can make progress',async()=>{
  const entered=deferred(),release=deferred();
  const f=fixture({click:async driver=>{if(driver.binding.accountId===A){entered.resolve();await release.promise;}}});
  const first=await open(f),second=await open(f,beta);
  const active=invoke(f,'browser_click',reference(first));await entered.promise;
  const queued=invoke(f,'browser_observe',{session_id:first.sessionId});
  const parallel=success(await invoke(f,'browser_click',reference(second),beta));
  assert.match(parallel.observation.status,/Count 1/);assert.equal(f.drivers.find(value=>value.binding.accountId===A).count,0);
  release.resolve();success(await active);success(await queued);
  const alphaActions=f.events.filter(value=>value.accountId===A).map(value=>value.operation);
  assert.deepEqual(alphaActions.slice(-3),['click','observe','observe']);
});

test('concurrent same-account opens do not allocate more than one driver',async()=>{
  const f=fixture();const results=await Promise.all(Array.from({length:5},()=>open(f)));
  assert.equal(f.drivers.length,1);assert.equal(new Set(results.map(value=>value.sessionId)).size,1);
});

test('concurrent different-worker opens reserve global capacity while a driver is being created',async()=>{
  const entered=deferred(),release=deferred();let created=0;
  const f=fixture({maxSessions:1,createDriver:async()=>{
    created++;entered.resolve();await release.promise;
    return {observe:async()=>({title:'Fixture',status:'Ready',targets:[]}),click:async()=>{},fill:async()=>{},screenshot:async()=>({mimeType:'image/png',data:'iVBORw0KGgo='}),close:async()=>{}};
  }});
  const first=invoke(f,'browser_open');await entered.promise;
  failure(await invoke(f,'browser_open',{},beta));assert.equal(created,1);
  release.resolve();success(await first);
});

test('resource cap denies a new profile without evicting an authorized existing profile',async()=>{
  const f=fixture({maxSessions:1}),session=await open(f);
  failure(await invoke(f,'browser_open',{},beta));
  assert.equal(f.drivers.length,1);assert.equal(f.drivers[0].closed,false);
  success(await invoke(f,'browser_observe',{session_id:session.sessionId}));
});

test('generated session-ID collision closes only the new driver, never deleting an existing worker session',async()=>{
  const f=fixture({uuid:()=> 'collision'}),session=await open(f);
  failure(await invoke(f,'browser_open',{},beta),'INTERNAL');
  assert.equal(f.drivers[0].closed,false);assert.equal(f.drivers[1].closed,true);
  success(await invoke(f,'browser_observe',{session_id:session.sessionId}));
});

test('close releases a session and resource capacity only after authorized driver close',async()=>{
  const f=fixture({maxSessions:1}),session=await open(f);
  success(await invoke(f,'browser_close',{session_id:session.sessionId}));
  assert.equal(f.drivers[0].closed,true);
  failure(await invoke(f,'browser_observe',{session_id:session.sessionId}));
  const other=await open(f,beta);assert.notEqual(other.sessionId,session.sessionId);
});

test('strict schemas reject identity, profile, selector, URL, and JavaScript overrides',async()=>{
  const f=fixture(),session=await open(f);
  for(const extra of [{accountId:B},{binding:binding(B,AGENT_B)},{profile:'/private/profile'},{path:'/private/profile'},{token:PRIVATE},{url:'https://external.example'},{javascript:'alert(1)'},{selector:'#increment'},{action:'click'}]) {
    failure(await invoke(f,'browser_open',extra),'VALIDATION');
    failure(await invoke(f,'browser_click',{...reference(session),...extra}),'VALIDATION');
  }
  assert.equal(f.drivers.length,1);assert.equal(f.drivers[0].count,0);
});

test('malformed invocation envelopes and missing or incorrectly typed fields are rejected',async()=>{
  const f=fixture();
  for(const invocation of [null,[],1,'browser_open',{name:'browser_open',arguments:null},{name:'browser_open',arguments:[]},{name:'browser_open',arguments:{},actor:A}])failure(await f.controller.callTool(invocation,alpha),'VALIDATION');
  failure(await invoke(f,'browser_unsafe_eval',{code:'1+1'}),'UNKNOWN_TOOL');
  for(const [name,args] of [['browser_observe',{}],['browser_observe',{session_id:1}],['browser_click',{session_id:'x',observation_id:'y'}],['browser_fill',{session_id:'x',observation_id:'y',target_id:'z',text:7}],['browser_screenshot',{session_id:'x'}],['browser_close',{}]])failure(await invoke(f,name,args),'VALIDATION');
  assert.equal(f.drivers.length,0);
});

test('invocation arguments are snapshotted before asynchronous authorization',async()=>{
  const entered=deferred(),release=deferred();let block=false;
  const f=fixture({authorize:async(context,{auth})=>{if(block){entered.resolve();await release.promise;}return structuredClone(auth[context.connection]);}});
  const session=await open(f),args={...reference(session),target_id:'draft',text:'Original'};block=true;
  const pending=invoke(f,'browser_fill',args);await entered.promise;args.text='Changed later';args.target_id='increment';args.profile=PRIVATE;release.resolve();
  success(await pending);assert.equal(f.drivers[0].text,'Original');
  const approval=f.approvals.find(value=>value.action.name==='browser_fill');assert.equal(approval.action.arguments.text,'Original');assert.equal(Object.hasOwn(approval.action.arguments,'profile'),false);
});

test('mutating trusted-authority objects cannot switch the queued operation identity',async()=>{
  const entered=deferred(),release=deferred();let block=false;
  const f=fixture({authorize:async(context,{auth})=>auth[context.connection],authorizeAction:async()=>{if(block){entered.resolve();await release.promise;}return true;}});
  const session=await open(f);block=true;
  const pending=invoke(f,'browser_click',reference(session));await entered.promise;
  f.auth.alpha.accountId=B;f.auth.alpha.agentId=AGENT_B;release.resolve();
  failure(await pending);assert.equal(f.drivers.length,1);assert.equal(f.drivers[0].binding.accountId,A);
});

test('driver and authority failures have uniform safe error text, never raw exception payloads',async()=>{
  const f=fixture({observe:async()=>{throw Object.assign(new Error(PRIVATE),{stack:PRIVATE,profilePath:PRIVATE});}});
  failure(await invoke(f,'browser_open'),'INTERNAL');
  const denied=fixture({authorizeAction:async()=>{throw new Error(PRIVATE);}});failure(await invoke(denied,'browser_open'));
});

test('uncertain driver mutation invalidates the previous observation rather than allowing blind retry',async()=>{
  const f=fixture({click:async driver=>{driver.count++;throw new Error(PRIVATE);}}),session=await open(f);
  failure(await invoke(f,'browser_click',reference(session)),'INTERNAL');
  failure(await invoke(f,'browser_click',reference(session)),'STALE_OBSERVATION');
  failure(await invoke(f,'browser_screenshot',{session_id:session.sessionId,observation_id:session.observation.id}),'STALE_OBSERVATION');
  assert.equal(f.drivers[0].count,1);
  const current=await observed(f,session);assert.notEqual(current.observation.id,session.observation.id);
});

test('driver observation and screenshot extra fields never escape the result allowlist',async()=>{
  const f=fixture(),session=await open(f);
  assert.equal(Object.hasOwn(session.observation,'profilePath'),false);
  assert.equal(Object.hasOwn(session.observation,'storageState'),false);
  const shot=success(await invoke(f,'browser_screenshot',{session_id:session.sessionId,observation_id:session.observation.id}));
  assert.equal(JSON.stringify(shot).includes(PRIVATE),false);
  assert.equal(JSON.stringify(shot).includes('profilePath'),false);assert.equal(JSON.stringify(shot).includes('storageState'),false);
});

test('duplicate or invalid observed targets are rejected instead of advertising ambiguous handles',async()=>{
  for(const targets of [[{id:'same',role:'button',name:'One'},{id:'same',role:'button',name:'Two'}],[{id:'bad',role:'password',name:'Secret'}],[{id:1,role:'button',name:'Invalid'}]]) {
    const f=fixture({observe:async()=>({title:'Fixture',status:'Ready',targets})});
    failure(await invoke(f,'browser_open'));
  }
});

test('missing, malformed, or swapped authority cannot create a browser',async()=>{
  for(const value of [null,{},[],{...binding(),workspaceId:''},{...binding(),accountId:'manager'},{...binding(),agentId:''},{...binding(),runId:''}]){
    const f=fixture({authorize:async()=>value});failure(await invoke(f,'browser_open'));assert.equal(f.drivers.length,0);
  }
});

test('an unauthenticated caller cannot close another worker by supplying its session identifier',async()=>{
  const f=fixture(),session=await open(f);delete f.auth.beta;
  failure(await invoke(f,'browser_observe',{session_id:session.sessionId},beta));
  assert.equal(f.drivers[0].closed,false);
  success(await invoke(f,'browser_observe',{session_id:session.sessionId}));
});
