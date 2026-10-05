import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState,applyOperation,HubError} from '../engine.mjs';
import {RelayAPI} from '../api.mjs';
import {createHandler,createDatabaseRPC} from '../backend/handler.mjs';
import {environment} from '../relay-cli.mjs';
import {handle as bridgeHandle} from '../bridge.mjs';

const origin='https://doublekingwasabi1819-a11y.github.io';
const apiURL='https://relay.example/functions/v1/relay';
const manager={id:'owner',owner:true};
const forge={id:'forge',session:'run-forge',owner:false};
function initialState(){
  let state=emptyState();
  for(const [id,name] of [['forge','Forge'],['scout','Scout']]){
    state=applyOperation(state,{id,type:'agent.add',payload:{name,role:'Builder'}},manager);
    state=applyOperation(state,{id:`run-${id}`,type:'agent.session',payload:{agentId:id}},manager);
  }
  return applyOperation(state,{id:'task-a',type:'task.add',payload:{title:'Movement',acceptance:'Turning remains stable'}},manager);
}
const fail=(message,code)=>{throw new HubError(message,code);};

/** This is an RPC-contract fixture, not a replacement for live SQL ACL tests. */
function database({loseAcknowledgement=false}={}) {
  let state=initialState(),writes=0;
  const calls=[];
  const sessions={
    'manager-token':{user:{id:'manager-account',name:'Owner',role:'manager'},actor:manager},
    'worker-token':{user:{id:'forge-account',name:'Forge',role:'worker'},actor:forge},
    'scout-token':{user:{id:'scout-account',name:'Scout',role:'worker'},actor:{id:'scout',session:'run-scout',owner:false}}
  };
  const rpc=async(action,token,data={})=>{
    calls.push({action,token,data:structuredClone(data)});
    if(action==='status')return {needsSetup:false};
    if(action==='login')return {token:'worker-token',expiresAt:new Date(Date.now()+60000).toISOString()};
    if(action==='setup')return {token:'manager-token',expiresAt:new Date(Date.now()+60000).toISOString()};
    const session=sessions[token];
    if(!session)fail('Sign in again.','SESSION');
    if(action==='context')return {capabilities:{taskLifecycleV1:true},...structuredClone(session),state:structuredClone(state),room:{accountId:session.user.id,body:'Private room',version:0}};
    if(action==='messages.composer.send'){
      const next=applyOperation(state,data.op,session.actor);
      if(next!==state){state=next;writes++;if(loseAcknowledgement&&writes===1)fail('Lost response.','NETWORK');}
      return {state};
    }
    if(action==='board.commit'){
      if(state.revision!==data.expectedRevision)fail('Someone saved first.','CONFLICT');
      state=structuredClone(data.state);writes++;
      if(loseAcknowledgement&&writes===1)fail('Lost response.','NETWORK');
      return {state};
    }
    if(action==='room.read'||action==='room.save'){
      const accountId=data.accountId||session.user.id;
      if(accountId!==session.user.id&&session.user.role!=='manager')fail('You can only access your own room.','FORBIDDEN');
      return {accountId,body:data.body||'Private room',version:1};
    }
    if(action==='logout'){delete sessions[token];return {ok:true};}
    return {ok:true};
  };
  return {rpc,calls,get:()=>state,writes:()=>writes};
}
function request(action,data={},token='worker-token',extra={}){
  return new Request(apiURL,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(token?{Authorization:`Bearer ${token}`} :{}),...extra},body:JSON.stringify({action,data})});
}
async function response(handler,action,data={},token='worker-token',headers={}){
  const res=await handler(request(action,data,token,headers));return {status:res.status,headers:res.headers,body:await res.json()};
}
function memoryStorage(){const saved=new Map();return {getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key),saved};}

test('protected actions reject a missing token before calling the database',async()=>{
  const db=database(),handler=createHandler({rpc:db.rpc});
  for(const action of ['context','room.read','operation','workers.create','workspace.delete','messages.capabilities','messages.get','messages.metadata','messages.history','messages.send','messages.notifications','messages.notifications.ack']){
    const result=await response(handler,action,{},'');assert.equal(result.status,401);assert.equal(result.body.error.code,'SESSION');
  }
  assert.equal(db.calls.length,0);
});

test('workers cannot invoke any manager account action or grant themselves manager role',async()=>{
  const db=database(),handler=createHandler({rpc:db.rpc});
  for(const action of ['workers.create','workers.update','workers.reset','workers.delete','password.change','recovery.rotate','workspace.delete']){
    const result=await response(handler,action,{role:'manager',owner:true,currentPassword:'synthetic-password'});
    assert.equal(result.status,403,action);assert.equal(result.body.error.code,'FORBIDDEN');
  }
  assert.ok(db.calls.every(call=>call.action==='context'));
});

test('manager account commands are allowed with server-confirmed manager session only',async()=>{
  const db=database(),handler=createHandler({rpc:db.rpc});
  const result=await response(handler,'workers.create',{name:'New worker',username:'new-worker',password:'synthetic-password',workRole:'Builder',role:'manager',owner:true},'manager-token');
  assert.equal(result.status,200);
  const sent=db.calls.find(call=>call.action==='workers.create');
  assert.equal(sent.data.name,'New worker');assert.ok(!('role' in sent.data));assert.ok(!('owner' in sent.data));
});

test('room requests strip role/actor spoofing and propagate SQL room authorization',async()=>{
  const db=database(),handler=createHandler({rpc:db.rpc});
  const result=await response(handler,'room.save',{body:'overwrite',expectedVersion:0,accountId:'scout-account',role:'manager',owner:true,actor:manager});
  assert.equal(result.status,403);
  assert.deepEqual(db.calls.at(-1).data,{body:'overwrite',expectedVersion:0,accountId:'scout-account'});
  const own=await response(handler,'room.save',{body:'my note',expectedVersion:0,role:'manager'});
  assert.equal(own.body.accountId,'forge-account');assert.equal(own.body.body,'my note');
});

test('public API never exposes board.commit or allows raw state replacement',async()=>{
  const db=database(),handler=createHandler({rpc:db.rpc});
  const revision=db.get().revision;
  for(const token of ['worker-token','manager-token']){
    const result=await response(handler,'board.commit',{expectedRevision:revision,state:emptyState('forged')},token);assert.equal(result.status,404);
  }
  assert.equal(db.get().revision,revision);assert.equal(db.calls.length,0);
});

test('setup uses server-generated empty state and strips role/actor additions',async()=>{
  const db=database(),handler=createHandler({rpc:db.rpc});
  const result=await response(handler,'setup',{setupCode:'synthetic-code',name:'Owner',username:'owner',password:'synthetic-password',state:initialState(),actor:manager,role:'manager'},'');
  assert.equal(result.status,200);
  const sent=db.calls.at(-1).data;
  assert.equal(sent.state.revision,0);assert.equal(sent.state.agents.length,0);assert.equal(sent.state.tasks.length,0);
  assert.ok(!('actor' in sent));assert.ok(!('role' in sent));assert.match(sent.rateKey,/^[a-f0-9]{64}$/);
});

test('CORS accepts exact site origin and omits access headers for a lookalike',async()=>{
  const db=database(),handler=createHandler({rpc:db.rpc});
  const good=await response(handler,'status',{},'');
  assert.equal(good.headers.get('Access-Control-Allow-Origin'),origin);
  assert.equal(good.headers.get('Cache-Control'),'no-store');
  for(const site of [origin+'.attacker.example','https://attacker.example','null']){
    const denied=await response(handler,'status',{},'',{Origin:site});assert.equal(denied.status,403);assert.equal(denied.headers.get('Access-Control-Allow-Origin'),null);
  }
  const preflight=await handler(new Request(apiURL,{method:'OPTIONS',headers:{Origin:origin}}));assert.equal(preflight.status,204);
  assert.equal(db.calls.length,1);
});

test('server limits actual request size without trusting Content-Length',async()=>{
  const db=database(),handler=createHandler({rpc:db.rpc});
  const huge=await handler(new Request(apiURL,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':'1'},body:JSON.stringify({action:'login',data:{password:'x'.repeat(66000)}})}));
  assert.equal(huge.status,413);assert.equal(db.calls.length,0);
  const declared=await response(handler,'status',{},'',{'Content-Length':'66000'});assert.equal(declared.status,413);
});

test('bad JSON, non-object action data and wrong content type fail safely',async()=>{
  const handler=createHandler({rpc:database().rpc});
  const malformed=await handler(new Request(apiURL,{method:'POST',headers:{'Content-Type':'application/json'},body:'{oops'}));assert.equal(malformed.status,400);
  for(const data of [[],null,'text',4])assert.equal((await response(handler,'status',data,'')).status,400);
  assert.equal((await response(handler,'status',{},'',{'Content-Type':'text/plain'})).status,400);
  const method=await handler(new Request(apiURL));assert.equal(method.status,405);
});

test('operation role/actor spoofing cannot take another identity or perform manager writes',async()=>{
  const db=database(),handler=createHandler({rpc:db.rpc});
  const claimed=await response(handler,'operation',{owner:true,actor:manager,op:{id:'claim-forge',type:'task.claim',actor:manager,owner:true,payload:{taskId:'task-a',agentId:'scout'}}});
  assert.equal(claimed.status,200);assert.equal(db.get().tasks[0].owner,'forge');
  const denied=await response(handler,'operation',{actor:manager,op:{id:'spoof-project',type:'project.update',actor:manager,payload:{name:'Takeover'}}});assert.equal(denied.status,403);
  const disallowed=await response(handler,'operation',{op:{id:'spoof-agent',type:'agent.add',payload:{name:'Fake',role:'manager'}}});assert.equal(disallowed.status,400);
});

test('simultaneous authenticated claims result in one owner after conflict retry',async()=>{
  const db=database(),handler=createHandler({rpc:db.rpc});
  const results=await Promise.all([
    response(handler,'operation',{op:{id:'forge-claim',type:'task.claim',payload:{taskId:'task-a'}}},'worker-token'),
    response(handler,'operation',{op:{id:'scout-claim',type:'task.claim',payload:{taskId:'task-a'}}},'scout-token')
  ]);
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);assert.equal(db.writes(),1);
  assert.ok(['forge','scout'].includes(db.get().tasks[0].owner));
});

test('public messages route to atomic composer RPC with server-derived senders',async()=>{
  const db=database(),handler=createHandler({rpc:db.rpc});
  const results=await Promise.all([
    response(handler,'operation',{op:{id:'message-forge',type:'message.add',payload:{body:'Forge here',from:'owner'}}},'worker-token'),
    response(handler,'operation',{op:{id:'message-scout',type:'message.add',payload:{body:'Scout here',from:'owner'}}},'scout-token')
  ]);
  assert.ok(results.every(result=>result.status===200));assert.equal(db.writes(),2);
  assert.deepEqual(db.get().messages.map(message=>message.from).sort(),['forge','scout']);
  assert.equal(db.calls.filter(c=>c.action==='messages.composer.send').length,2);
  assert.ok(db.calls.every(c=>c.action!=='board.commit'));
});

test('lost commit acknowledgement and repeated operation IDs do not duplicate a write',async()=>{
  const db=database({loseAcknowledgement:true}),handler=createHandler({rpc:db.rpc});
  const data={op:{id:'once',type:'message.add',payload:{body:'Saved once'}}};
  assert.equal((await response(handler,'operation',data)).status,200);
  assert.equal((await response(handler,'operation',data)).status,200);
  assert.equal(db.writes(),1);assert.equal(db.get().messages.length,1);
});

test('unknown database failures and service credentials do not leak through the public handler',async()=>{
  const secret='synthetic-service-secret';
  let backendRequest;
  const rpc=createDatabaseRPC({url:'https://database.example',serviceKey:secret,fetcher:async(url,options)=>{
    backendRequest={url,options};return Response.json({message:`internal SQL and ${secret}`},{status:500});
  }});
  const result=await response(createHandler({rpc}),'status',{},'');
  assert.equal(result.status,503);assert.equal(result.body.error.code,'DATABASE');
  assert.doesNotMatch(JSON.stringify(result.body),/synthetic-service-secret|internal SQL/);
  assert.equal(backendRequest.options.headers.Authorization,`Bearer ${secret}`);
  assert.equal(backendRequest.url,'https://database.example/rest/v1/rpc/relay_rpc');
  const unknown=await response(createHandler({rpc:async()=>{throw new Error(secret);}}),'status',{},'');
  assert.equal(unknown.status,500);assert.doesNotMatch(JSON.stringify(unknown.body),/synthetic-service-secret/);
});

test('browser session persistence stores token and expiry without password or recovery code',async()=>{
  const storage=memoryStorage(),expiresAt=new Date(Date.now()+60000).toISOString();
  const client=new RelayAPI({base:apiURL,storage,fetcher:async()=>Response.json({token:'synthetic-session',expiresAt,recoveryCode:'synthetic-recovery'})});
  await client.login({role:'worker',username:'forge',password:'synthetic-password'});
  const stored=storage.getItem(client.storageKey);
  assert.deepEqual(JSON.parse(stored),{base:apiURL,token:'synthetic-session',expiresAt});assert.doesNotMatch(stored,/password|recovery/);
  const restored=new RelayAPI({base:apiURL,storage});assert.equal(restored.restore(),true);assert.equal(restored.token,'synthetic-session');
});

test('restore rejects expired, malformed and differently scoped sessions',()=>{
  const storage=memoryStorage(),client=new RelayAPI({base:apiURL,storage});
  for(const saved of ['invalid',JSON.stringify({base:apiURL,token:'old',expiresAt:'2001-01-01'}),JSON.stringify({base:'https://other.example',token:'elsewhere',expiresAt:'2999-01-01'})]){
    storage.setItem(client.storageKey,saved);assert.equal(client.restore(),false);assert.equal(client.token,'');assert.equal(storage.getItem(client.storageKey),null);
  }
});

test('logout removes local session even if server request fails and never sends password',async()=>{
  const storage=memoryStorage();let headers,body;
  const client=new RelayAPI({base:apiURL,storage,fetcher:async(_url,options)=>{headers=options.headers;body=JSON.parse(options.body);throw new Error('offline');}});
  client.remember({token:'synthetic-session',expiresAt:'2999-01-01'});client.snapshot={private:'room'};
  await assert.rejects(client.logout(),error=>error.code==='NETWORK');assert.equal(client.token,'');assert.equal(client.snapshot,null);assert.equal(storage.getItem(client.storageKey),null);
  assert.equal(headers.Authorization,'Bearer synthetic-session');assert.deepEqual(body,{action:'logout',data:{}});
});

test('server-revoked session clears browser credential',async()=>{
  const storage=memoryStorage(),client=new RelayAPI({base:apiURL,storage,fetcher:async()=>Response.json({error:{code:'SESSION',message:'Sign in again.'}},{status:401})});
  client.remember({token:'revoked',expiresAt:'2999-01-01'});
  await assert.rejects(client.context(),error=>error.code==='SESSION');assert.equal(client.token,'');assert.equal(storage.getItem(client.storageKey),null);
});

test('CLI password sign-in logs in once and ignores obsolete owner/repository variables',async()=>{
  const calls=[];
  const {store}=await environment({RELAY_API_URL:apiURL,RELAY_USERNAME:'forge',RELAY_PASSWORD:'synthetic-password',RELAY_OWNER:'yes',RELAY_AGENT_ID:'owner',GITHUB_TOKEN:'unused'},
    {fetcher:async(url,options)=>{calls.push({url,body:JSON.parse(options.body),headers:options.headers});return Response.json({token:'worker-token',expiresAt:'2999-01-01'});}});
  assert.equal(calls.length,1);assert.deepEqual(calls[0].body,{action:'login',data:{role:'worker',username:'forge',password:'synthetic-password'}});
  assert.equal(calls[0].url,apiURL);assert.equal(store.token,'worker-token');assert.equal(store.storage,null);assert.equal(store.actor,undefined);
});

test('CLI supplied session token avoids password login and refuses missing credentials',async()=>{
  let calls=0;
  const {store}=await environment({RELAY_API_URL:apiURL,RELAY_SESSION_TOKEN:'worker-token'},{fetcher:async()=>{calls++;throw new Error('should not log in');}});
  assert.equal(calls,0);assert.equal(store.token,'worker-token');
  await assert.rejects(environment({RELAY_API_URL:apiURL}),/environment secrets/);
  await assert.rejects(environment({RELAY_REPO:'old/repo',GITHUB_TOKEN:'unused'}),/RELAY_API_URL/);
});

test('MCP room tool cannot forward a forged account or role, and board writes contain no actor',async()=>{
  const calls=[];
  const getClient=async()=>({store:{call:async(action,data)=>{calls.push({action,data});return {ok:true};},mutate:async operation=>{calls.push({operation});return {revision:9};}}});
  const room=await bridgeHandle({method:'tools/call',params:{name:'relay_room_save',arguments:{body:'My notes',expected_version:2,accountId:'other',owner:true}}},getClient);
  assert.equal(room.isError,undefined);assert.deepEqual(calls[0],{action:'room.save',data:{body:'My notes',expectedVersion:2}});
  await bridgeHandle({method:'tools/call',params:{name:'relay_claim',arguments:{task_id:'task-a',operation_id:'mcp-claim',actor:manager}}},getClient);
  assert.deepEqual(calls[1],{operation:{id:'mcp-claim',type:'task.claim',payload:{taskId:'task-a'}}});
  const listed=await bridgeHandle({method:'tools/list'});assert.ok(listed.tools.some(tool=>tool.name==='relay_room_read'));
});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('unavailable browser storage does not prevent account construction or in-memory login',()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  try{
    Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get(){throw new Error('Browser storage blocked');}});
    const client=new RelayAPI({base:apiURL});
    assert.equal(client.storage,null);assert.equal(client.restore(),false);
    client.remember({token:'memory-only',expiresAt:'2999-01-01'});assert.equal(client.token,'memory-only');
    client.disconnect();assert.equal(client.token,'');
    const explicit=new RelayAPI({base:apiURL,storage:null});assert.equal(explicit.storage,null);
  }finally{if(descriptor)Object.defineProperty(globalThis,'sessionStorage',descriptor);else delete globalThis.sessionStorage;}
});

test('late session error from previous account cannot sign out a newer account',async()=>{
  const pending=deferred(),storage=memoryStorage();let authorization;
  const client=new RelayAPI({base:apiURL,storage,fetcher:async(_url,options)=>{authorization=options.headers.Authorization;return pending.promise;}});
  client.remember({token:'old-account',expiresAt:'2999-01-01'});
  const request=client.context();
  client.remember({token:'new-account',expiresAt:'2999-01-01'});client.snapshot={user:{id:'new-user'}};
  pending.resolve(Response.json({error:{code:'SESSION',message:'Old session expired'}},{status:401}));
  await assert.rejects(request,error=>error.code==='SESSION');
  assert.equal(authorization,'Bearer old-account');assert.equal(client.token,'new-account');
  assert.deepEqual(client.snapshot,{user:{id:'new-user'}});assert.equal(JSON.parse(storage.getItem(client.storageKey)).token,'new-account');
});

test('late context response cannot restore signed-out private data or overwrite a new account',async()=>{
  for(const replacement of [null,'new-account']){
    const pending=deferred(),client=new RelayAPI({base:apiURL,storage:null,fetcher:async()=>pending.promise});
    client.remember({token:'old-account',expiresAt:'2999-01-01'});
    const request=client.context();client.disconnect();
    if(replacement){client.remember({token:replacement,expiresAt:'2999-01-01'});client.snapshot={user:{id:'new-user'}};}
    const expectedSnapshot=client.snapshot;
    pending.resolve(Response.json({user:{id:'old-user'},room:{body:'Old private note'}}));
    const result=await request;
    assert.equal(result.user.id,'old-user');assert.equal(client.snapshot,expectedSnapshot);assert.equal(client.token,replacement||'');
  }
});

test('logout completion or failure for old session cannot clear a subsequent login',async()=>{
  for(const success of [true,false]){
    const pending=deferred(),storage=memoryStorage();let authorization;
    const client=new RelayAPI({base:apiURL,storage,fetcher:async(_url,options)=>{authorization=options.headers.Authorization;return pending.promise;}});
    client.remember({token:'old-account',expiresAt:'2999-01-01'});
    const signout=client.logout();
    client.remember({token:'new-account',expiresAt:'2999-01-01'});
    if(success){pending.resolve(Response.json({ok:true}));await signout;}
    else{pending.reject(new Error('Offline'));await assert.rejects(signout,error=>error.code==='NETWORK');}
    assert.equal(authorization,'Bearer old-account');assert.equal(client.token,'new-account');assert.equal(JSON.parse(storage.getItem(client.storageKey)).token,'new-account');
  }
});

test('remembering another session clears the previous private snapshot',()=>{
  const client=new RelayAPI({base:apiURL,storage:null});
  client.remember({token:'old-account',expiresAt:'2999-01-01'});client.snapshot={room:{body:'Old private note'}};
  client.remember({token:'new-account',expiresAt:'2999-01-01'});
  assert.equal(client.snapshot,null);
});

test('a completed old-account mutation cannot fetch current-account context as its result',async()=>{
  const pending=deferred(),requests=[];
  const client=new RelayAPI({base:apiURL,storage:null,fetcher:async(_url,options)=>{requests.push(JSON.parse(options.body));return pending.promise;}});
  client.remember({token:'old-account',expiresAt:'2999-01-01'});
  const saved=client.mutate({id:'old-write',type:'message.add',payload:{body:'Original account'}});
  client.remember({token:'new-account',expiresAt:'2999-01-01'});
  pending.resolve(Response.json({state:{revision:1}}));
  await assert.rejects(saved,error=>error.code==='ACCOUNT_CHANGED');
  assert.equal(requests.length,1);assert.equal(requests[0].action,'operation');assert.equal(client.token,'new-account');
});


test('canonical message routes use the privileged message transport and strip envelope spoofing',async()=>{
  const sent=[];
  const rpc=createDatabaseRPC({url:'https://database.example/',serviceKey:'synthetic-only',fetcher:async(url,options)=>{
    sent.push({url,...JSON.parse(options.body)});return Response.json({ok:true});
  }});
  const handler=createHandler({rpc});
  const routes=[
    ['messages.capabilities',{}],['messages.get',{messageId:'message-id'}],
    ['messages.metadata',{messageIds:['message-id']}],['messages.history',{beforeId:'message-id'}],
    ['messages.send',{command:{clientId:'synthetic-client'}}],['messages.notifications',{limit:20}],
    ['messages.notifications.ack',{notificationId:'notification-id'}],
  ];
  for(const [action,data] of routes){
    const result=await response(handler,action,{...data,role:'manager',actor:manager,owner:true});
    assert.equal(result.status,200);const actual=sent.at(-1);
    assert.equal(actual.url,'https://database.example/rest/v1/rpc/relay_message_rpc');
    assert.equal(actual.p_action,action);assert.equal(actual.p_token,'worker-token');assert.deepEqual(actual.p_data,data);
  }
  await response(handler,'dm.send',{recipientId:'recipient-id',body:'Reply',clientId:'client-id',replyToMessageId:'reply-id',owner:true});
  assert.equal(sent.at(-1).url,'https://database.example/rest/v1/rpc/relay_dm_rpc');
  assert.deepEqual(sent.at(-1).p_data,{recipientId:'recipient-id',body:'Reply',clientId:'client-id',replyToMessageId:'reply-id'});
  const internal=await response(handler,'messages.composer.send',{op:{id:'internal',type:'message.add',payload:{body:'No'}}});
  assert.equal(internal.status,404);
});
