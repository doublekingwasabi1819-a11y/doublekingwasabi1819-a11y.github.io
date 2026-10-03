import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayIntegration,relayTools,RelayIntegrationError} from '../integrations/browser-relay.mjs';

// Contract fixtures only: no real accounts, credentials, browser, or database.
const base='https://relay.example/functions/v1/relay';
const workspaceId='fixture-workspace';
const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const C='33333333-3333-4333-8333-333333333333';
const AGENT_A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENT_B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MESSAGE='44444444-4444-4444-8444-444444444444';
const SECOND_MESSAGE='55555555-5555-4555-8555-555555555555';
const CLIENT='66666666-6666-4666-8666-666666666666';
const CURSOR='77777777-7777-4777-8777-777777777777';
const TOKEN_A='a'.repeat(64),TOKEN_B='b'.repeat(64);
const SCOPES=['relay:read','relay:write','browser:control'];
const PRIVATE='private-fixture-secret-that-must-not-be-forwarded';
const requestA={connection:'alpha'},requestB={connection:'beta'};

function context(id=A,agentId=AGENT_A,name='Alpha',runId='run-alpha'){
  return {
    user:{id,agentId,name,username:name.toLowerCase(),role:'worker',enabled:true,workRole:'Builder',model:'Fixture',token:PRIVATE,password:PRIVATE},
    actor:{id:agentId,owner:false,session:runId},
    notifications:{unreadDirectMessages:2,token:PRIVATE},
    room:{accountId:id,body:PRIVATE,version:4},workers:[{password:PRIVATE}],
    state:{agents:[{session:PRIVATE}],messages:[{body:PRIVATE}]},token:PRIVATE
  };
}
function message({id=MESSAGE,senderId=A,recipientId=B,body='Literal <script>text</script>',readAt=null}={}){
  return {id,senderId,recipientId,body,createdAt:'2026-10-03T03:00:00Z',readAt,token:PRIVATE,password:PRIVATE,clientId:CLIENT};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(options={}){
  const calls=[],resolutions=[],sent=new Map();
  const sessions={
    alpha:{token:TOKEN_A,accountId:A,runId:'run-alpha',scopes:[...SCOPES]},
    beta:{token:TOKEN_B,accountId:B,runId:'run-beta',scopes:[...SCOPES]}
  };
  const contexts={alpha:context(),beta:context(B,AGENT_B,'Beta','run-beta')};
  const fetcher=async(url,init)=>{
    const payload=JSON.parse(init.body),token=init.headers.Authorization?.replace(/^Bearer /,'');
    const sessionKey=token===TOKEN_A?'alpha':token===TOKEN_B?'beta':null;
    const call={url,action:payload.action,data:payload.data,token,init:{...init,headers:{...init.headers}}};
    calls.push(call);
    if(options.beforeResponse)await options.beforeResponse(call);
    if(options.respond){const custom=await options.respond(call,{sessions,contexts,calls});if(custom!==undefined)return custom instanceof Response?custom:Response.json(custom);}
    if(!sessionKey)return Response.json({error:{code:'SESSION',message:PRIVATE}},{status:401});
    if(payload.action==='context')return Response.json(contexts[sessionKey]);
    // Simulated Relay database identity is independent of mutable OAuth bindings.
    const accountId=contexts[sessionKey].user.id,other=accountId===A?B:A;
    if(payload.action==='dm.inbox')return Response.json({contacts:[{id:other,name:'Other',role:'worker',enabled:true,password:PRIVATE}],threads:[{participantA:accountId,participantB:other,lastMessage:message({senderId:other,recipientId:accountId}),unreadCount:2,secret:PRIVATE}],unreadCount:2,secret:PRIVATE});
    if(payload.action==='dm.thread')return Response.json({messages:[message({senderId:payload.data.participantB,recipientId:accountId})],hasMore:false,secret:PRIVATE});
    if(payload.action==='dm.send'){
      const key=token+':'+payload.data.clientId,previous=sent.get(key);
      if(previous&&(previous.recipientId!==payload.data.recipientId||previous.body!==payload.data.body.trim()))return Response.json({error:{code:'CONFLICT',message:PRIVATE}},{status:409});
      const value=previous||message({senderId:accountId,recipientId:payload.data.recipientId,body:payload.data.body.trim()});
      sent.set(key,value);return Response.json({message:value,secret:PRIVATE});
    }
    if(payload.action==='dm.read')return Response.json({markedRead:payload.data.messageIds.length,unreadCount:1,secret:PRIVATE});
    throw new Error('Unrecognized fixture action');
  };
  const resolveSession=async request=>{
    resolutions.push(request);
    return options.resolveSession?options.resolveSession(request,{sessions,contexts,calls}):structuredClone(sessions[request?.connection]);
  };
  const integration=createRelayIntegration({base,workspaceId,resolveSession,fetcher});
  return {integration,calls,resolutions,sessions,contexts,fetcher};
}
async function invoke(f,name='relay_fast_identity',args={},request=requestA){return f.integration.callTool({name,arguments:args},request);}
function successful(result){assert.notEqual(result.isError,true,JSON.stringify(result));assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);return result.structuredContent;}
function failed(result,code){assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,code);assert.equal(result.content[0].text,result.structuredContent.error.message);assert.ok(!JSON.stringify(result).includes(PRIVATE));assert.ok(!JSON.stringify(result).includes(TOKEN_A));assert.ok(!JSON.stringify(result).includes(TOKEN_B));return result;}
const sendArguments=()=>({recipient_id:B,body:'Authorized fixture message',client_id:CLIENT});

test('tool definitions expose bounded schemas, explicit scopes, and conservative Relay metadata',()=>{
  assert.deepEqual(relayTools.map(t=>t.name),['relay_fast_identity','relay_fast_inbox','relay_fast_thread','relay_fast_send','relay_fast_mark_read']);
  for(const tool of relayTools){
    assert.equal(tool.inputSchema.additionalProperties,false);
    assert.equal(tool.annotations.destructiveHint,false);assert.equal(tool.annotations.openWorldHint,false);
    assert.equal(tool.securitySchemes[0].type,'oauth2');
    assert.deepEqual(tool.securitySchemes[0].scopes,[['relay_fast_send','relay_fast_mark_read'].includes(tool.name)?'relay:write':'relay:read']);
    assert.equal(tool.annotations.readOnlyHint,!['relay_fast_send','relay_fast_mark_read'].includes(tool.name));
    assert.ok(!Object.keys(tool.inputSchema.properties).some(key=>/token|password|profile|actor|role|base|path/.test(key)));
  }
  const mark=relayTools.find(t=>t.name==='relay_fast_mark_read').inputSchema.properties.message_ids;
  assert.equal(mark.maxItems,100);assert.equal(mark.uniqueItems,true);
});

test('constructor pins HTTPS configuration and rejects credentials, query, fragment, or invalid resolver/workspace',()=>{
  const valid={base,workspaceId,resolveSession:async()=>({})};
  for(const value of ['http://relay.example','http://localhost','file:///tmp/relay','https://user:password@relay.example','https://relay.example?token=secret','https://relay.example#secret'])assert.throws(()=>createRelayIntegration({...valid,base:value}));
  for(const value of ['',null,123,'x'.repeat(129)])assert.throws(()=>createRelayIntegration({...valid,workspaceId:value}));
  assert.throws(()=>createRelayIntegration({...valid,resolveSession:null}));
  assert.ok(createRelayIntegration(valid));
});

test('all Relay tools authorize with live context before invoking their action',async()=>{
  const cases=[['relay_fast_identity',{},null],['relay_fast_inbox',{},'dm.inbox'],['relay_fast_thread',{recipient_id:B},'dm.thread'],['relay_fast_send',sendArguments(),'dm.send'],['relay_fast_mark_read',{message_ids:[MESSAGE]},'dm.read']];
  for(const [name,args,action] of cases){
    const f=fixture();successful(await invoke(f,name,args));
    assert.deepEqual(f.calls.map(c=>c.action),['context',...(action?[action]:[])]);
    assert.equal(f.resolutions[0],requestA);
    for(const call of f.calls){assert.equal(call.token,TOKEN_A);assert.equal(call.url,base);assert.equal(call.init.cache,'no-store');assert.equal(call.init.credentials,'omit');assert.equal(call.init.referrerPolicy,'no-referrer');}
  }
});

test('concurrent requests isolate clients and captured bearer tokens',async()=>{
  const alphaContext=deferred(),arrived=deferred();
  const f=fixture({beforeResponse:async call=>{if(call.action==='context'&&call.token===TOKEN_A){arrived.resolve();await alphaContext.promise;}}});
  const first=invoke(f,'relay_fast_inbox');await arrived.promise;
  const second=invoke(f,'relay_fast_inbox',{},requestB);successful(await second);
  alphaContext.resolve();const a=successful(await first);
  assert.equal(a.threads[0].participantA,A);
  assert.deepEqual(f.calls.map(c=>[c.action,c.token]),[['context',TOKEN_A],['context',TOKEN_B],['dm.inbox',TOKEN_B],['dm.inbox',TOKEN_A]]);
});

test('browser authorization returns only server-derived binding and rechecks every call',async()=>{
  const f=fixture();
  assert.deepEqual(await f.integration.authorizeBrowser(requestA),{workspaceId,accountId:A,agentId:AGENT_A,runId:'run-alpha'});
  assert.deepEqual(await f.integration.authorizeBrowser(requestB),{workspaceId,accountId:B,agentId:AGENT_B,runId:'run-beta'});
  assert.deepEqual(await f.integration.authorizeBrowser(requestA),{workspaceId,accountId:A,agentId:AGENT_A,runId:'run-alpha'});
  assert.deepEqual(f.calls.map(c=>c.action),['context','context','context']);
});

test('request-scoped adapter never reads or writes ambient browser sessionStorage',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');let touched=0;
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get(){touched++;throw new Error(PRIVATE);}});
  try{const f=fixture();successful(await invoke(f));await f.integration.authorizeBrowser(requestA);assert.equal(touched,0);}
  finally{if(previous)Object.defineProperty(globalThis,'sessionStorage',previous);else delete globalThis.sessionStorage;}
});

test('invalid resolver authority fails before any Relay request',async()=>{
  const valid={token:TOKEN_A,accountId:A,runId:'run-alpha',scopes:[...SCOPES]};
  for(const resolved of [null,{}, {...valid,token:''},{...valid,token:'A'.repeat(64)},{...valid,token:'bad-token'},{...valid,accountId:AGENT_A.slice(1)},{...valid,runId:''},{...valid,runId:'x'.repeat(129)},{...valid,scopes:null}]){
    const f=fixture({resolveSession:async()=>resolved});failed(await invoke(f),'SESSION');assert.equal(f.calls.length,0);
  }
});

test('resolver authority requires string token rather than a coercible credential object',async()=>{
  const token={toString:()=>TOKEN_A};
  const f=fixture({resolveSession:async()=>({token,accountId:A,runId:'run-alpha',scopes:[...SCOPES]})});
  failed(await invoke(f),'SESSION');assert.equal(f.calls.length,0);
});

test('scopes are enforced independently for read, write, and browser control before backend calls',async()=>{
  for(const [name,args,granted] of [['relay_fast_identity',{},['relay:write','browser:control']],['relay_fast_send',sendArguments(),['relay:read','browser:control']],['relay_fast_mark_read',{message_ids:[]},['relay:read','browser:control']]]){
    const f=fixture();f.sessions.alpha.scopes=granted;failed(await invoke(f,name,args),'FORBIDDEN');assert.equal(f.calls.length,0);
  }
  const f=fixture();f.sessions.alpha.scopes=['relay:read','relay:write'];
  await assert.rejects(f.integration.authorizeBrowser(requestA),error=>error instanceof RelayIntegrationError&&error.code==='FORBIDDEN');assert.equal(f.calls.length,0);
});

test('manager, disabled, mismatched account/slot, owner spoofing, and malformed live context fail closed',async()=>{
  const patches=[
    c=>{c.user.role='manager';c.actor={id:'owner',owner:true,session:null};},
    c=>{c.user.enabled=false;},c=>{c.user.id=B;},c=>{c.user.agentId=AGENT_B;},
    c=>{c.actor.id=AGENT_B;},c=>{c.actor.owner=true;},c=>{c.actor.owner=undefined;},
    c=>{c.actor.session='';},c=>{c.user.agentId=null;},c=>{delete c.actor;},c=>{delete c.user;}
  ];
  for(const patch of patches){const f=fixture();patch(f.contexts.alpha);failed(await invoke(f,'relay_fast_inbox'),'FORBIDDEN');assert.deepEqual(f.calls.map(c=>c.action),['context']);}
});

test('changed live worker run blocks both Relay tools and persistent browser authorization',async()=>{
  const f=fixture();successful(await invoke(f));f.contexts.alpha.actor.session='replacement-run';
  failed(await invoke(f,'relay_fast_send',sendArguments()),'STALE_SESSION');
  await assert.rejects(f.integration.authorizeBrowser(requestA),error=>error.code==='STALE_SESSION');
  assert.ok(f.calls.every(c=>c.action==='context'));
});

test('revoked, stale, deleted, or disabled backend sessions cannot reuse earlier positive authorization',async()=>{
  for(const code of ['SESSION','UNAUTHORIZED','STALE_SESSION','DELETED']){
    let revoked=false;
    const f=fixture({respond:call=>revoked&&call.action==='context'?Response.json({error:{code,message:PRIVATE}},{status:401}):undefined});
    successful(await invoke(f));revoked=true;
    failed(await invoke(f,'relay_fast_send',sendArguments()),code==='UNAUTHORIZED'?'INTERNAL':code);
    assert.deepEqual(f.calls.map(c=>c.action),['context','context']);
  }
});

test('unknown tools and malformed argument objects fail before resolver or network access',async()=>{
  const f=fixture();failed(await invoke(f,'relay_arbitrary_execute',{}),'UNKNOWN_TOOL');
  for(const args of [null,[],1,'text',Object.create(null),new Date()])failed(await invoke(f,'relay_fast_identity',args),'VALIDATION');
  assert.equal(f.resolutions.length,0);assert.equal(f.calls.length,0);
});

test('malformed invocation itself returns normalized validation rather than leaking an exception',async()=>{
  const f=fixture();
  for(const invocation of [null,[],4,'text',{name:'relay_fast_identity',token:PRIVATE},{name:'relay_fast_identity',profile:'manager'},{name:'relay_fast_identity',requestContext:requestB}])failed(await f.integration.callTool(invocation,requestA),'VALIDATION');
  assert.equal(f.resolutions.length,0);assert.equal(f.calls.length,0);
});

test('advertised UUID schema accepts uppercase hex consistently with the runtime validator',async()=>{
  const f=fixture(),recipient=AGENT_B.toUpperCase();
  const tool=relayTools.find(t=>t.name==='relay_fast_thread');
  assert.ok(new RegExp(tool.inputSchema.properties.recipient_id.pattern).test(recipient));
  successful(await invoke(f,'relay_fast_thread',{recipient_id:recipient}));
  assert.equal(f.calls[1].data.participantB,recipient);
});

test('mutating advertised schemas cannot change runtime argument or credential validation',async()=>{
  const tool=relayTools.find(t=>t.name==='relay_fast_send'),saved=structuredClone(tool.inputSchema);
  try{
    tool.inputSchema.properties.token={type:'string'};tool.inputSchema.required.length=0;tool.inputSchema.additionalProperties=true;
    const f=fixture();failed(await invoke(f,'relay_fast_send',{...sendArguments(),token:PRIVATE}),'VALIDATION');
    failed(await invoke(f,'relay_fast_send',{}),'VALIDATION');assert.equal(f.calls.length,0);
  }finally{tool.inputSchema=saved;}
});

test('credential, actor, profile, endpoint, and arbitrary-action fields cannot enter tool arguments',async()=>{
  const f=fixture();
  for(const [key,value] of Object.entries({token:PRIVATE,password:PRIVATE,actor:{id:B,owner:true},role:'manager',account_id:B,profile_id:'../manager',profile:'manager',path:'/tmp/manager',base:'https://attacker.example',action:'workers.create',recipientId:B})){
    failed(await invoke(f,'relay_fast_send',{...sendArguments(),[key]:value}),'VALIDATION');
  }
  assert.equal(f.resolutions.length,0);assert.equal(f.calls.length,0);
});

test('UUID, required field, body Unicode/byte limits and self-recipient validation are enforced',async()=>{
  const f=fixture();
  for(const args of [{},{recipient_id:B},{...sendArguments(),recipient_id:'beta'},{...sendArguments(),client_id:'bad'},{...sendArguments(),body:''},{...sendArguments(),body:'   '},{...sendArguments(),body:null},{...sendArguments(),body:'x'.repeat(12001)},{...sendArguments(),body:'😀'.repeat(12001)}])failed(await invoke(f,'relay_fast_send',args),'VALIDATION');
  assert.equal(f.calls.length,0);
  successful(await invoke(f,'relay_fast_send',{...sendArguments(),body:'😀'.repeat(12000)}));
  failed(await invoke(f,'relay_fast_send',{...sendArguments(),recipient_id:A}),'VALIDATION');
  assert.equal(f.calls.filter(c=>c.action==='dm.send').length,1);
});

test('thread maps authenticated account ID and requested recipient/cursor rather than worker-slot IDs',async()=>{
  const f=fixture();successful(await invoke(f,'relay_fast_thread',{recipient_id:B,before_id:CURSOR}));
  assert.deepEqual(f.calls[1].data,{participantA:A,participantB:B,beforeId:CURSOR});
  successful(await invoke(f,'relay_fast_thread',{recipient_id:B}));assert.deepEqual(f.calls[3].data,{participantA:A,participantB:B});
  const before=f.calls.length;failed(await invoke(f,'relay_fast_thread',{recipient_id:B,participant_a:C}),'VALIDATION');assert.equal(f.calls.length,before);
});

test('arguments are cloned before authentication awaits and cannot change an authorized send',async()=>{
  const gate=deferred(),entered=deferred();
  const f=fixture({resolveSession:async(_request,{sessions})=>{entered.resolve();await gate.promise;return sessions.alpha;}});
  const args=sendArguments(),pending=invoke(f,'relay_fast_send',args);await entered.promise;
  args.recipient_id=C;args.body='Mutated after invocation';args.client_id=SECOND_MESSAGE;args.password=PRIVATE;
  gate.resolve();successful(await pending);
  assert.deepEqual(f.calls[1].data,{recipientId:B,body:'Authorized fixture message',clientId:CLIENT});
});

test('message-ID arrays are cloned before authentication awaits',async()=>{
  const gate=deferred(),entered=deferred();
  const f=fixture({resolveSession:async(_request,{sessions})=>{entered.resolve();await gate.promise;return sessions.alpha;}});
  const args={message_ids:[MESSAGE]},pending=invoke(f,'relay_fast_mark_read',args);await entered.promise;
  args.message_ids.push(SECOND_MESSAGE);args.message_ids[0]=CURSOR;gate.resolve();successful(await pending);
  assert.deepEqual(f.calls[1].data,{messageIds:[MESSAGE]});
});

test('resolver-owned authority is captured before live-context await',async()=>{
  const gate=deferred(),entered=deferred();
  const f=fixture({resolveSession:async(_request,{sessions})=>sessions.alpha,beforeResponse:async call=>{if(call.action==='context'){entered.resolve();await gate.promise;}}});
  const pending=invoke(f,'relay_fast_send',sendArguments());await entered.promise;
  f.sessions.alpha.token=TOKEN_B;f.sessions.alpha.accountId=B;f.sessions.alpha.runId='run-beta';f.sessions.alpha.scopes=[];
  gate.resolve();successful(await pending);
  assert.deepEqual(f.calls.map(c=>c.token),[TOKEN_A,TOKEN_A]);assert.equal(f.calls[1].data.recipientId,B);
});

test('identity and inbox output are narrow, secret-free DTOs with consistent MCP content',async()=>{
  const f=fixture();
  const identity=successful(await invoke(f));
  assert.deepEqual(identity,{user:{id:A,name:'Alpha',role:'worker',agentId:AGENT_A},unreadDirectMessages:2});
  const inbox=successful(await invoke(f,'relay_fast_inbox'));
  assert.deepEqual(Object.keys(inbox).sort(),['contacts','threads','unreadCount']);
  assert.deepEqual(Object.keys(inbox.contacts[0]).sort(),['enabled','id','name','role']);
  assert.deepEqual(Object.keys(inbox.threads[0].lastMessage).sort(),['body','createdAt','id','readAt','recipientId','senderId']);
  assert.ok(!JSON.stringify({identity,inbox}).includes(PRIVATE));assert.ok(!JSON.stringify(identity).includes('run-alpha'));
});

test('thread and send output omit unknown response fields while preserving literal DM text',async()=>{
  const f=fixture();const thread=successful(await invoke(f,'relay_fast_thread',{recipient_id:B}));
  assert.equal(thread.messages[0].body,'Literal <script>text</script>');
  const sent=successful(await invoke(f,'relay_fast_send',sendArguments()));
  assert.deepEqual(Object.keys(sent),['message']);assert.ok(!JSON.stringify({thread,sent}).includes(PRIVATE));
});

test('DM DTO rejects non-scalar readAt values rather than forwarding embedded secret objects',async()=>{
  for(const action of ['dm.inbox','dm.thread','dm.send']){
    const malformed=message({readAt:{token:PRIVATE}});
    const f=fixture({respond:call=>{
      if(call.action!==action)return undefined;
      if(action==='dm.inbox')return {contacts:[],threads:[{participantA:A,participantB:B,lastMessage:malformed,unreadCount:1}],unreadCount:1};
      return action==='dm.thread'?{messages:[malformed],hasMore:false}:{message:malformed};
    }});
    const name=action==='dm.inbox'?'relay_fast_inbox':action==='dm.thread'?'relay_fast_thread':'relay_fast_send';
    failed(await invoke(f,name,action==='dm.inbox'?{}:action==='dm.thread'?{recipient_id:B}:sendArguments()),'INTERNAL');
  }
});

test('DM readAt accepts only the expected null or string scalar contract',async()=>{
  for(const readAt of [null,'2026-10-03T03:01:00Z']){
    const f=fixture({respond:call=>call.action==='dm.thread'?{messages:[message({readAt})],hasMore:false}:undefined});
    assert.equal(successful(await invoke(f,'relay_fast_thread',{recipient_id:B})).messages[0].readAt,readAt);
  }
  for(const readAt of [undefined,0,true,[],{}]){
    const value=message({readAt});if(readAt===undefined)delete value.readAt;
    const f=fixture({respond:call=>call.action==='dm.thread'?{messages:[value],hasMore:false}:undefined});
    failed(await invoke(f,'relay_fast_thread',{recipient_id:B}),'INTERNAL');
  }
});

test('thread privacy rejects messages outside the requested participants and excessive or malformed pages',async()=>{
  const responses=[
    {messages:[message({senderId:C,recipientId:B})],hasMore:false},
    {messages:[message({senderId:A,recipientId:C})],hasMore:false},
    {messages:Array.from({length:51},()=>message()),hasMore:true},
    {messages:[],hasMore:'false'}, {messages:null,hasMore:false},
    {messages:[message({id:'invalid'})],hasMore:false},
    {messages:[message({body:{token:PRIVATE}})],hasMore:false}
  ];
  for(const response of responses){const f=fixture({respond:call=>call.action==='dm.thread'?response:undefined});failed(await invoke(f,'relay_fast_thread',{recipient_id:B}),'INTERNAL');}
});

test('inbox privacy validates contact/participant/message relationships and unread counts',async()=>{
  const good={contacts:[{id:B,name:'Beta',role:'worker',enabled:true}],threads:[{participantA:A,participantB:B,lastMessage:message(),unreadCount:1}],unreadCount:1};
  const patches=[v=>{v.contacts[0].id=A;},v=>{v.contacts[0].role='owner';},v=>{v.contacts[0].enabled='true';},v=>{v.threads[0].participantA=C;},v=>{v.threads[0].participantB=A;},v=>{v.threads[0].lastMessage.recipientId=C;},v=>{v.threads[0].unreadCount=-1;},v=>{v.unreadCount=1.5;}];
  for(const patch of patches){const response=structuredClone(good);patch(response);const f=fixture({respond:call=>call.action==='dm.inbox'?response:undefined});failed(await invoke(f,'relay_fast_inbox'),'INTERNAL');}
});

test('send output must be from the authenticated worker to the requested recipient',async()=>{
  for(const result of [message({senderId:B,recipientId:A}),message({senderId:A,recipientId:C}),message({senderId:C,recipientId:B})]){
    const f=fixture({respond:call=>call.action==='dm.send'?{message:result}:undefined});failed(await invoke(f,'relay_fast_send',sendArguments()),'INTERNAL');
  }
});

test('uncertain sends reuse exactly the same UUID mapping and backend conflicts remain normalized',async()=>{
  const f=fixture(),args=sendArguments();
  const first=successful(await invoke(f,'relay_fast_send',args));const retried=successful(await invoke(f,'relay_fast_send',args));
  assert.equal(first.message.id,retried.message.id);
  assert.deepEqual(f.calls.filter(c=>c.action==='dm.send').map(c=>c.data),[{recipientId:B,body:args.body,clientId:CLIENT},{recipientId:B,body:args.body,clientId:CLIENT}]);
  failed(await invoke(f,'relay_fast_send',{...args,body:'Changed retry'}),'CONFLICT');
  failed(await invoke(f,'relay_fast_send',{...args,recipient_id:C}),'CONFLICT');
});

test('thread reading does not implicitly mark messages read; acknowledgments contain only supplied IDs',async()=>{
  const f=fixture();successful(await invoke(f,'relay_fast_thread',{recipient_id:B}));
  assert.ok(!f.calls.some(c=>c.action==='dm.read'));
  assert.deepEqual(successful(await invoke(f,'relay_fast_mark_read',{message_ids:[MESSAGE,SECOND_MESSAGE]})),{markedRead:2,unreadCount:1});
  assert.deepEqual(f.calls.at(-1).data,{messageIds:[MESSAGE,SECOND_MESSAGE]});
  assert.deepEqual(successful(await invoke(f,'relay_fast_mark_read',{message_ids:[]})),{markedRead:0,unreadCount:1});
});

test('read IDs reject invalid arrays, oversized lists, and case-insensitive duplicates before auth',async()=>{
  const f=fixture();
  for(const message_ids of [null,'all',[null],['bad'],Array(101).fill(MESSAGE),[AGENT_A,AGENT_A.toUpperCase()]])failed(await invoke(f,'relay_fast_mark_read',{message_ids}),'VALIDATION');
  assert.equal(f.calls.length,0);assert.equal(f.resolutions.length,0);
});

test('the maximum 100 distinct supplied read IDs remains within the documented server bound',async()=>{
  const f=fixture(),message_ids=Array.from({length:100},(_,i)=>'99999999-9999-4999-8999-'+i.toString(16).padStart(12,'0'));
  assert.deepEqual(successful(await invoke(f,'relay_fast_mark_read',{message_ids})),{markedRead:100,unreadCount:1});
  assert.deepEqual(f.calls[1].data,{messageIds:message_ids});
});

test('read acknowledgment validates bounded counts and omits backend secret fields',async()=>{
  for(const result of [{markedRead:2,unreadCount:0},{markedRead:-1,unreadCount:0},{markedRead:0,unreadCount:'1'}]){
    const f=fixture({respond:call=>call.action==='dm.read'?result:undefined});failed(await invoke(f,'relay_fast_mark_read',{message_ids:[MESSAGE]}),'INTERNAL');
  }
});

test('arbitrary resolver errors and all backend error texts are normalized without credential leakage',async()=>{
  const resolver=fixture({resolveSession:async()=>{throw Object.assign(new Error(PRIVATE+TOKEN_A),{code:'UNEXPECTED'});}});
  failed(await invoke(resolver),'INTERNAL');assert.equal(resolver.calls.length,0);
  await assert.rejects(resolver.integration.authorizeBrowser(requestA),error=>error.code==='INTERNAL'&&!error.message.includes(PRIVATE));
  for(const code of ['SESSION','STALE_SESSION','DELETED','FORBIDDEN','CONFLICT','NOT_FOUND','RATE_LIMIT','NETWORK','INTERNAL','OTHER']){
    const f=fixture({respond:call=>call.action==='dm.send'?Response.json({error:{code,message:PRIVATE+TOKEN_A}},{status:500}):undefined});
    failed(await invoke(f,'relay_fast_send',sendArguments()),code==='OTHER'?'INTERNAL':code);
  }
});

test('resolver-thrown integration errors are reconstructed even when their message or code was mutated',async()=>{
  for(const [code,expected] of [['SESSION','SESSION'],['FORBIDDEN','FORBIDDEN'],['UNKNOWN_RESOLVER_CODE','INTERNAL']]){
    const injected=new RelayIntegrationError('SESSION');injected.code=code;injected.message=PRIVATE+TOKEN_A;
    const f=fixture({resolveSession:async()=>{throw injected;}});
    failed(await invoke(f),expected);assert.equal(f.calls.length,0);
    await assert.rejects(f.integration.authorizeBrowser(requestA),error=>error instanceof RelayIntegrationError&&error!==injected&&error.code===expected&&!error.message.includes(PRIVATE)&&!error.message.includes(TOKEN_A));
  }
});

test('network and unreadable responses produce safe errors rather than raw fetch/parse details',async()=>{
  const offline=fixture({beforeResponse:async()=>{throw new Error(PRIVATE+TOKEN_A);}});failed(await invoke(offline),'NETWORK');
  const unreadable=fixture({respond:()=>new Response(PRIVATE,{status:200})});failed(await invoke(unreadable),'NETWORK');
});

test('malformed identity display or notification count does not leak raw context',async()=>{
  for(const patch of [c=>{c.user.name=null;},c=>{c.notifications.unreadDirectMessages=-1;},c=>{c.notifications.unreadDirectMessages='2';},c=>{delete c.notifications;}]){
    const f=fixture();patch(f.contexts.alpha);failed(await invoke(f),'INTERNAL');
  }
});
