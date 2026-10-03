import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOAuthGrantBridge} from '../oauth-bridge.mjs';
import {createRelayBrowserHost} from '../relay-host.mjs';
import {relayDirectToolDescriptors} from '../mcp-tool-metadata.mjs';

// Controlled verifier identities test composition policy, never signatures,
// a provider/code/PKCE flow, TLS, actual Relay credentials or ChatGPT linking.
const RESOURCE='https://mcp.bridge.fixture.invalid/mcp',ISSUER='https://issuer.bridge.fixture.invalid';
const contexts=[Object.freeze({grantId:'oauth-lease-a'}),Object.freeze({grantId:'oauth-lease-b'})];
const references=contexts.map((_,index)=>Object.freeze({fixtureWorker:index}));
const INTERNAL='internal-controlled-bearer-separate-from-oauth-123456';
const PRIVATE='private-relay-worker-token-profile-path';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const body=(name='browser_open',args={})=>({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
const request=(value=body(),token='fixture-oauth-a',options={})=>new Request(`${RESOURCE}${options.suffix||''}`,{
  method:'POST',headers:{host:new URL(RESOURCE).host,'content-type':'application/json',authorization:`Bearer ${token}`,...options.headers},
  body:typeof value==='string'?value:JSON.stringify(value),...options.requestOptions
});
function fixture(t,options={}){
  let timestamp=1000000,failCleanup=false;const issued=[],revoked=[],forwarded=[],mapped=[],verified=[];
  const credentials=new Map(contexts.map((context,index)=>[`fixture-oauth-${index?'b':'a'}`,{
    claims:{iss:ISSUER,sub:`subject-${index}`,aud:RESOURCE,exp:2000,scope:'browser:control relay:read relay:write',jti:`lease-${index}`},
    principalId:context.grantId,requestContext:context
  }]));
  const host=Object.freeze({
    issueGrant(value){issued.push(value);return {grantId:`private-grant-${issued.length}`,token:`${INTERNAL}-${issued.length}`,expiresAt:timestamp+value.ttlMs};},
    async revokeGrant(id){revoked.push(id);if(failCleanup)throw new Error(PRIVATE);},
    async fetch(req){forwarded.push({authorization:req.headers.get('authorization'),url:req.url,host:req.headers.get('host'),body:await req.text()});return new Response('{"fixture":"ok"}',{headers:{'content-type':'application/json'}});},
    async close(){},...options.host
  });
  const bridge=createOAuthGrantBridge({host,resource:RESOURCE,issuers:[ISSUER],now:()=>timestamp,
    verifyAccessToken:async token=>{verified.push(token);if(!credentials.has(token))throw new Error(PRIVATE);return credentials.get(token);},
    resolveHostReference:async identity=>{mapped.push(identity);return references[contexts.indexOf(identity.requestContext)];},...options.bridge});
  t.after(()=>bridge.close().catch(()=>{}));
  return {bridge,credentials,issued,revoked,forwarded,mapped,verified,host,
    setTime(value){timestamp=value;},failCleanup(value){failCleanup=value;}};
}

test('bridge requires reviewed private host capabilities and does not activate a listener',()=>{
  assert.throws(()=>createOAuthGrantBridge(),TypeError);
  assert.throws(()=>createOAuthGrantBridge({host:{fetch(){}},resource:RESOURCE}),TypeError);
});

test('exact HTTPS metadata is public and viewer, bad Host, Origin, path and forwarded claims are rejected before verification',async t=>{
  const f=fixture(t);
  const metadata=await f.bridge.fetch(new Request(f.bridge.metadataUrl,{headers:{host:new URL(RESOURCE).host}}));
  assert.equal(metadata.status,200);assert.deepEqual((await metadata.json()).scopes_supported,['browser:control','relay:read','relay:write']);
  for(const req of [request(body(),'fixture-oauth-a',{suffix:'?worker=other'}),
    new Request(RESOURCE.replace('/mcp','/viewer'),{headers:{host:new URL(RESOURCE).host}}),
    request(body(),'fixture-oauth-a',{headers:{host:'evil.fixture.invalid'}}),
    request(body(),'fixture-oauth-a',{headers:{origin:'https://evil.fixture.invalid'}}),
    new Request(RESOURCE.replace('https:','http:'),{method:'POST',headers:{host:new URL(RESOURCE).host,'x-forwarded-proto':'https','content-type':'application/json'},body:JSON.stringify(body())})]){
    assert.ok([403,404].includes((await f.bridge.fetch(req)).status));
  }
  assert.equal(f.verified.length,0);assert.equal(f.issued.length,0);assert.equal(f.forwarded.length,0);
});

test('wrong audience, malformed claims and missing baseline scope never map or issue private grants',async t=>{
  for(const patch of [{aud:'https://relay.fixture.invalid'}, {exp:1000}, {scope:'relay:write'}]){
    const f=fixture(t);const identity=f.credentials.get('fixture-oauth-a');f.credentials.set('fixture-oauth-a',{...identity,claims:{...identity.claims,...patch}});
    const result=await f.bridge.fetch(request());assert.ok([401,403].includes(result.status));
    assert.equal(f.mapped.length,0);assert.equal(f.issued.length,0);assert.equal(f.forwarded.length,0);
    assert.doesNotMatch(await result.text(),/private-relay|profile-path/);
  }
});

test('read-only OAuth refuses send before mapping with a precise tool-level write challenge',async t=>{
  const f=fixture(t),identity=f.credentials.get('fixture-oauth-a');f.credentials.set('fixture-oauth-a',{...identity,claims:{...identity.claims,scope:'browser:control relay:read'}});
  const result=await f.bridge.fetch(request(body('relay_fast_send',{body:'controlled text'})));
  assert.equal(result.status,200);const value=(await result.json()).result;assert.equal(value.isError,true);
  assert.match(value._meta['mcp/www_authenticate'][0],/scope="browser:control relay:write"/);
  assert.equal(f.mapped.length,0);assert.equal(f.issued.length,0);assert.equal(f.forwarded.length,0);
});

test('browser-only OAuth refuses Relay reads and missing OAuth returns the same exact required scopes',async t=>{
  const f=fixture(t),identity=f.credentials.get('fixture-oauth-a');f.credentials.set('fixture-oauth-a',{...identity,claims:{...identity.claims,scope:'browser:control'}});
  const denied=await f.bridge.fetch(request(body('relay_fast_inbox')));assert.match((await denied.json()).result._meta['mcp/www_authenticate'][0],/scope="browser:control relay:read"/);
  const missing=await f.bridge.fetch(request(body('relay_fast_send'),'not-a-verified-token'));
  assert.equal(missing.status,401);assert.match(missing.headers.get('www-authenticate'),/scope="browser:control relay:write"/);
  assert.equal(f.mapped.length,0);assert.equal(f.issued.length,0);
});

test('verified request maps only allowed scopes once and forwards only a separate memory-only bearer to the exact host URL',async t=>{
  const f=fixture(t),identity=f.credentials.get('fixture-oauth-a');f.credentials.set('fixture-oauth-a',{...identity,claims:{...identity.claims,scope:'browser:control relay:read admin:unknown'}});
  for(let i=0;i<2;i++)assert.equal((await f.bridge.fetch(request(body('relay_fast_inbox')))).status,200);
  assert.equal(f.mapped.length,1);assert.equal(f.issued.length,1);assert.equal(f.verified.length,2);
  assert.deepEqual(f.mapped[0].scopes,['browser:control','relay:read']);assert.equal(Object.isFrozen(f.mapped[0]),true);
  assert.equal(f.issued[0].requestContext,references[0]);assert.ok(f.issued[0].ttlMs<=1000000);
  assert.equal(f.forwarded.every(row=>row.authorization.startsWith(`Bearer ${INTERNAL}`)),true);
  assert.equal(f.forwarded.every(row=>row.url===RESOURCE&&row.host===new URL(RESOURCE).host),true);
  assert.doesNotMatch(f.forwarded[0].body,/fixture-oauth|internal-controlled|private-relay/);
});

test('near-expiry OAuth cannot invoke a mapping or extend authorization through the 1s host grant minimum',async t=>{
  const f=fixture(t);f.setTime(1999500);
  assert.equal((await f.bridge.fetch(request())).status,401);assert.equal(f.mapped.length,0);assert.equal(f.issued.length,0);
});

test('concurrent first use maps one permanent reference and mints one internal grant',async t=>{
  const start=deferred(),finish=deferred();let mappings=0;
  const f=fixture(t,{bridge:{resolveHostReference:async()=>{mappings++;start.resolve();await finish.promise;return references[0];}}});
  const first=f.bridge.fetch(request());await start.promise;const second=f.bridge.fetch(request());finish.resolve();
  assert.deepEqual((await Promise.all([first,second])).map(value=>value.status),[200,200]);
  assert.equal(mappings,1);assert.equal(f.issued.length,1);
});

test('revocation during a slow mapping prevents late grant creation and terminal context resurrection',async t=>{
  const start=deferred(),finish=deferred();
  const f=fixture(t,{bridge:{resolveHostReference:async()=>{start.resolve();await finish.promise;return references[0];}}});
  const pending=f.bridge.fetch(request());await start.promise;await f.bridge.revokeContext(contexts[0]);finish.resolve();
  assert.equal((await pending).status,401);assert.equal(f.issued.length,0);assert.equal(f.forwarded.length,0);
  assert.equal((await f.bridge.fetch(request())).status,401);assert.equal(f.issued.length,0);
});

test('provider revocation retires only the already verified private grant and preserves another principal',async t=>{
  const f=fixture(t);await f.bridge.fetch(request());await f.bridge.fetch(request(body(),'fixture-oauth-b'));
  f.credentials.delete('fixture-oauth-a');assert.equal((await f.bridge.fetch(request())).status,401);
  assert.deepEqual(f.revoked,['private-grant-1']);assert.equal((await f.bridge.fetch(request(body(),'fixture-oauth-b'))).status,200);
});

test('failed cleanup quarantines the exact grant, denies forwarding, and allows trusted retry',async t=>{
  const f=fixture(t);await f.bridge.fetch(request());f.failCleanup(true);
  assert.deepEqual(await f.bridge.revokeContext(contexts[0]),{isError:true,closed:false});
  assert.equal((await f.bridge.fetch(request())).status,401);assert.equal(f.forwarded.length,1);
  f.failCleanup(false);assert.deepEqual(await f.bridge.revokeContext(contexts[0]),{closed:true});assert.deepEqual(f.revoked,['private-grant-1','private-grant-1']);
});

test('expiry during an in-flight result discards output and retires the exact grant',async t=>{
  const start=deferred(),finish=deferred();const f=fixture(t,{host:{async fetch(){start.resolve();await finish.promise;return new Response(PRIVATE);}}});
  const pending=f.bridge.fetch(request());await start.promise;f.setTime(2000000);finish.resolve();
  const response=await pending;assert.equal(response.status,401);assert.doesNotMatch(await response.text(),/private-relay/);assert.deepEqual(f.revoked,['private-grant-1']);
});

test('a request that observes an expired internal lease retires it before its real-time timer fires',async t=>{
  const f=fixture(t);assert.equal((await f.bridge.fetch(request())).status,200);f.setTime(1999050);
  assert.equal((await f.bridge.fetch(request())).status,401);assert.deepEqual(f.revoked,['private-grant-1']);assert.equal(f.forwarded.length,1);
});

test('a malformed issued grant with a known ID is retired before any private host forwarding',async t=>{
  const f=fixture(t,{host:{issueGrant(){return {grantId:'known-faulty-issued-grant',token:'malformed',expiresAt:1500000};}}});
  assert.equal((await f.bridge.fetch(request())).status,401);assert.deepEqual(f.revoked,['known-faulty-issued-grant']);assert.equal(f.forwarded.length,0);
});

test('mapping timeouts cancel their hook and late completion cannot mint a grant',async t=>{
  const finish=deferred();let signal;
  const f=fixture(t,{bridge:{mapTimeout:10,resolveHostReference:async(_identity,options)=>{signal=options.signal;await finish.promise;return references[0];}}});
  assert.equal((await f.bridge.fetch(request())).status,401);assert.equal(signal.aborted,true);finish.resolve();
  await Promise.resolve();assert.equal(f.issued.length,0);assert.equal(f.forwarded.length,0);
});

test('byte bounds and unsupported RPC/tool surfaces reject before verification or mapping',async t=>{
  const f=fixture(t,{bridge:{maxBodyBytes:256}});
  for(const value of [JSON.stringify(body()).padEnd(300,' '),{jsonrpc:'2.0',id:1,method:'resources/read'},body('browser_fill'),body('arbitrary_tool'),[{jsonrpc:'2.0',id:1,method:'ping'}]]){
    assert.ok([400,413].includes((await f.bridge.fetch(request(value))).status));
  }
  assert.equal(f.verified.length,0);assert.equal(f.mapped.length,0);assert.equal(f.issued.length,0);
});

test('a body that never finishes is canceled on a bounded deadline before verification',async t=>{
  let canceled=false;const f=fixture(t,{bridge:{mapTimeout:10}});
  const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){canceled=true;}});
  const req=new Request(RESOURCE,{method:'POST',headers:{host:new URL(RESOURCE).host,'content-type':'application/json'},body:stream,duplex:'half'});
  assert.equal((await f.bridge.fetch(req)).status,408);assert.equal(canceled,true);assert.equal(f.verified.length,0);assert.equal(f.issued.length,0);
});

test('a nonthrowing cleanup error quarantines capacity and can be retried by its exact context',async t=>{
  let failed=true;const f=fixture(t,{host:{async revokeGrant(){return failed?{isError:true}:undefined;}}});
  await f.bridge.fetch(request());assert.deepEqual(await f.bridge.revokeContext(contexts[0]),{isError:true,closed:false});
  assert.equal((await f.bridge.fetch(request())).status,401);assert.equal(f.forwarded.length,1);
  failed=false;assert.deepEqual(await f.bridge.revokeContext(contexts[0]),{closed:true});
});

test('forward timeout retires authorization while an uncertain source operation finishes',async t=>{
  const finish=deferred();const f=fixture(t,{bridge:{forwardTimeout:10},host:{async fetch(){await finish.promise;return new Response(PRIVATE);}}});
  const response=await f.bridge.fetch(request());assert.equal(response.status,503);assert.deepEqual(f.revoked,['private-grant-1']);
  finish.resolve();assert.doesNotMatch(await response.text(),/private-relay/);assert.equal((await f.bridge.fetch(request())).status,401);
});

test('concurrency bounds apply before verification while an authorized mapping is pending',async t=>{
  const start=deferred(),finish=deferred();const f=fixture(t,{bridge:{maxRequests:1,resolveHostReference:async()=>{start.resolve();await finish.promise;return references[0];}}});
  const pending=f.bridge.fetch(request());await start.promise;assert.equal((await f.bridge.fetch(request(body(),'fixture-oauth-b'))).status,429);
  assert.equal(f.verified.length,1);finish.resolve();assert.equal((await pending).status,200);
});

async function wireFixture(t){
  let resource,bridge,privateHost,route,writeCalls=0,driverCloses=0;const clients=[],captured=[];
  const server=createServer(async(incoming,outgoing)=>{try{
    const pieces=[];for await(const piece of incoming)pieces.push(piece);
    // This trusted controlled front end supplies a fixed HTTPS resource URL.
    // It is not real TLS or forwarded-header trust.
    const request=new Request(`https://127.0.0.1:${server.address().port}${incoming.url}`,{method:incoming.method,
      headers:incoming.headers,...(incoming.method==='POST'?{body:Buffer.concat(pieces)}:{})});
    const response=await route(request);outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch{outgoing.writeHead(500);outgoing.end('Controlled fixture failure.');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;resource=`https://127.0.0.1:${port}/mcp`;const origin=new URL(resource).origin;
  const reference=Object.freeze({worker:'fixed-controlled-worker',lease:'read-only'}),writeReference=Object.freeze({worker:'fixed-controlled-worker',lease:'write'});
  const binding={workspaceId:'bridge-wire',accountId:'11111111-1111-4111-8111-111111111111',agentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',runId:'bridge-wire-run'};
  const adapter={tools:relayDirectToolDescriptors.map(tool=>({name:tool.name,description:tool.description,inputSchema:structuredClone(tool.inputSchema),annotations:structuredClone(tool.annotations),securitySchemes:[{type:'oauth2',scopes:[tool.annotations.readOnlyHint?'relay:read':'relay:write']}]})),
    async callTool(invocation,context){assert.ok(context===reference||context===writeReference);const args=invocation.arguments;let value;
      switch(invocation.name){
        case 'relay_fast_identity':value={user:{id:binding.accountId,name:'Controlled worker',role:'worker',agentId:binding.agentId},unreadDirectMessages:0};break;
        case 'relay_fast_inbox':value={contacts:[],threads:[],unreadCount:0};break;
        case 'relay_fast_thread':value={messages:[],hasMore:false};break;
        case 'relay_fast_send':assert.equal(context,writeReference);writeCalls++;value={message:{id:'44444444-4444-4444-8444-444444444444',senderId:binding.accountId,recipientId:args.recipient_id,body:args.body,createdAt:'2026-10-03T07:30:00Z',readAt:null}};break;
        case 'relay_fast_mark_read':assert.equal(context,writeReference);writeCalls++;value={markedRead:0,unreadCount:0};break;
      }
      return {structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]};
    }};
  privateHost=createRelayBrowserHost({resolveBinding:async context=>{assert.ok(context===reference||context===writeReference);return binding;},resolveWorkerSession:async()=>{throw new Error('The controlled test uses its explicit fake driver.');},authorizeAction:async()=>true,relayAdapter:adapter,
    createDriver:async()=>({async observe(){return {title:'Controlled bridge fixture',status:'Ready',targets:[{id:'refresh',role:'button',name:'Refresh'}]};},async click(){},async fill(){},async screenshot(){return {mimeType:'image/png',data:'iVBORw0KGgo='};},async close(){driverCloses++;}}),
    httpOptions:{allowedHostnames:['127.0.0.1'],allowedOrigins:[origin]}
  });
  const source=Object.freeze({fetch:async request=>{captured.push(request.headers.get('authorization'));return privateHost.fetch(request);},issueGrant:privateHost.issueGrant,revokeGrant:privateHost.revokeGrant,close:privateHost.close});
  const credentials=new Map([['wire-readonly-oauth',{claims:{iss:ISSUER,sub:'controlled-worker',aud:resource,exp:Math.floor(Date.now()/1000)+600,scope:'browser:control relay:read',jti:'wire-read-only'},principalId:contexts[0].grantId,requestContext:contexts[0]}],
    ['wire-write-oauth',{claims:{iss:ISSUER,sub:'controlled-worker',aud:resource,exp:Math.floor(Date.now()/1000)+600,scope:'browser:control relay:read relay:write',jti:'wire-write'},principalId:contexts[1].grantId,requestContext:contexts[1]}]]);
  bridge=createOAuthGrantBridge({host:source,resource,issuers:[ISSUER],verifyAccessToken:async token=>{if(!credentials.has(token))throw new Error(PRIVATE);return credentials.get(token);},resolveHostReference:async identity=>identity.requestContext===contexts[0]?reference:writeReference});route=bridge.fetch;
  t.after(async()=>{await Promise.all(clients.map(client=>client.close()));await bridge.close();await new Promise(resolve=>server.close(resolve));});
  async function connect(legacy,token='wire-readonly-oauth'){const client=new Client({name:'controlled-oauth-bridge-client',version:'0.1.0'});clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{authorization:`Bearer ${token}`}}}),legacy?{prior:{kind:'legacy'}}:undefined);return client;}
  return {connect,credentials,captured,get writeCalls(){return writeCalls;},get driverCloses(){return driverCloses;}};
}
for(const legacy of [false,true])test(`real ${legacy?'legacy':'modern'} HTTP MCP bridge preserves browser calls and rejects readonly writes before the private adapter`,async t=>{
  const f=await wireFixture(t),client=await f.connect(legacy);assert.equal((await client.listTools()).tools.length,10);
  const opened=await client.callTool({name:'browser_open',arguments:{}});assert.equal(opened.isError,undefined);const session=opened.structuredContent.sessionId;
  const observation=(await client.callTool({name:'browser_observe',arguments:{session_id:session}})).structuredContent.observation;
  const clicked=await client.callTool({name:'browser_click',arguments:{session_id:session,observation_id:observation.id,target_id:'refresh'}});
  assert.equal(clicked.isError,undefined);assert.equal((await client.callTool({name:'browser_screenshot',arguments:{session_id:session,observation_id:clicked.structuredContent.observation.id}})).isError,undefined);
  for(const [name,args]of [['relay_fast_identity',{}],['relay_fast_inbox',{}],['relay_fast_thread',{recipient_id:'22222222-2222-4222-8222-222222222222'}]])assert.equal((await client.callTool({name,arguments:args})).isError,undefined);
  const denied=await client.callTool({name:'relay_fast_send',arguments:{recipient_id:'22222222-2222-4222-8222-222222222222',client_id:'33333333-3333-4333-8333-333333333333',body:'Controlled fixture message.'}});assert.equal(denied.isError,true);
  assert.match(denied._meta['mcp/www_authenticate'][0],/scope="browser:control relay:write"/);assert.equal(f.writeCalls,0);
  assert.equal((await client.callTool({name:'relay_fast_mark_read',arguments:{message_ids:[]}})).isError,true);assert.equal(f.writeCalls,0);
  const writer=await f.connect(legacy,'wire-write-oauth');
  assert.equal((await writer.callTool({name:'relay_fast_send',arguments:{recipient_id:'22222222-2222-4222-8222-222222222222',client_id:'33333333-3333-4333-8333-333333333333',body:'Controlled fixture message.'}})).isError,undefined);
  assert.equal((await writer.callTool({name:'relay_fast_mark_read',arguments:{message_ids:[]}})).isError,undefined);assert.equal(f.writeCalls,2);
  assert.equal((await client.callTool({name:'browser_close',arguments:{session_id:session}})).isError,undefined);
  assert.equal((await client.callTool({name:'browser_open',arguments:{}})).isError,undefined);
  assert.equal(f.captured.some(value=>value.includes('wire-readonly-oauth')),false);
  f.credentials.delete('wire-readonly-oauth');await assert.rejects(client.callTool({name:'browser_open',arguments:{}}),/Authentication is required/);assert.equal(f.driverCloses,2);
});
