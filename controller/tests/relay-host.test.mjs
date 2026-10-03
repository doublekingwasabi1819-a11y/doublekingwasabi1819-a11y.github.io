import test from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {PROTOCOL_VERSION_META_KEY,CLIENT_CAPABILITIES_META_KEY} from '@modelcontextprotocol/server';
import {createRelayBrowserHost} from '../relay-host.mjs';
import {relayBrowserToolDescriptors,relayDirectToolDescriptors} from '../mcp-tool-metadata.mjs';

// Controlled adapters and fake browser drivers over actual loopback HTTP/MCP.
// No real Relay session, browser, login, credential extraction, or remote request.
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const AA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',BB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MID='33333333-3333-4333-8333-333333333333',CID='44444444-4444-4444-8444-444444444444';
const SECRET='mock-private-upstream-session-token-and-profile-path';
const UUID='^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$';
const id={type:'string',pattern:UUID};
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
function tools(){return [
  ['relay_fast_identity',object(),true],['relay_fast_inbox',object(),true],
  ['relay_fast_thread',object({recipient_id:id,before_id:id},['recipient_id']),true],
  ['relay_fast_send',object({recipient_id:id,body:{type:'string',minLength:1,maxLength:12000},client_id:id},['recipient_id','body','client_id']),false],
  ['relay_fast_mark_read',object({message_ids:{type:'array',items:id,maxItems:100,uniqueItems:true}},['message_ids']),false]
].map(([name,inputSchema,readOnlyHint])=>({name,description:'Controlled direct Relay adapter.',inputSchema,annotations:{readOnlyHint,destructiveHint:false,idempotentHint:true,openWorldHint:false},securitySchemes:[{type:'oauth2',scopes:[readOnlyHint?'relay:read':'relay:write']}]}));}
const message=(senderId=A,recipientId=B,body='Fixture message')=>({id:MID,senderId,recipientId,body,createdAt:'2026-10-03T00:00:00.000Z',readAt:null});
const authority=(index=0)=>({workspaceId:'combined-relay-fixture',accountId:index?B:A,agentId:index?BB:AA,runId:index?'run-b':'run-a'});
const ok=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;};
const errorCode=(r,code)=>{assert.equal(r.isError,true);assert.equal(r.structuredContent.error.code,code);assert.equal(JSON.stringify(r).includes(SECRET),false);};
async function fixture(t,options={}){
  const references=[Object.freeze({worker:0,private:SECRET}),Object.freeze({worker:1,private:SECRET})],states=references.map((reference,index)=>({reference,binding:authority(index),live:true,write:true,mode:'normal',resolveCalls:0,switchOnResolve:0}));
  const calls=[],drivers=[],clients=[];const definitions=tools();
  const adapter={tools:definitions,async callTool(invocation,reference){
    const state=states.find(s=>s.reference===reference);calls.push({invocation:structuredClone(invocation),reference});assert.ok(state,'Adapter must receive original trusted worker reference');
    if(state.mode==='throw')throw new Error(SECRET);
    if(state.mode==='safe-error')return {isError:true,structuredContent:{error:{code:'FORBIDDEN',message:SECRET}},content:[{type:'text',text:SECRET}]};
    if(state.mode==='unknown-error')return {isError:true,structuredContent:{error:{code:'UPSTREAM_SECRET',message:SECRET}},content:[{type:'text',text:SECRET}]};
    if(state.mode==='revoke')state.live=false;
    const owner=state.binding.accountId,peer=owner===A?B:A,args=invocation.arguments;
    if(!state.write&&['relay_fast_send','relay_fast_mark_read'].includes(invocation.name))return {isError:true,structuredContent:{error:{code:'FORBIDDEN',message:SECRET}}};
    let result;
    switch(invocation.name){
      case 'relay_fast_identity':result={user:{id:owner,name:owner===A?'Fixture A':'Fixture B',role:'worker',agentId:state.binding.agentId},unreadDirectMessages:1};break;
      case 'relay_fast_inbox':result={contacts:[{id:peer,name:'Fixture peer',role:'worker',enabled:true}],threads:[{participantA:owner,participantB:peer,lastMessage:message(peer,owner),unreadCount:1}],unreadCount:1};break;
      case 'relay_fast_thread':result={messages:[message(peer,owner)],hasMore:false};break;
      case 'relay_fast_send':result={message:message(owner,args.recipient_id,args.body)};break;
      case 'relay_fast_mark_read':result={markedRead:args.message_ids.length,unreadCount:0};break;
    }
    if(state.mode==='other-worker')result={user:{id:peer,name:'Other worker',role:'worker',agentId:state.binding.agentId},unreadDirectMessages:0};
    if(state.mode==='leak-field')result.user.token=SECRET;
    if(state.mode==='wrong-body'&&invocation.name==='relay_fast_send')result.message.body='Different fixture payload';
    // Deliberately untrusted textual metadata must never be copied into output.
    return {structuredContent:result,content:[{type:'text',text:SECRET}],debug:SECRET};
  }};
  const hooks={resolveBinding:async reference=>{const state=states.find(s=>s.reference===reference);if(!state?.live)throw new Error(SECRET);state.resolveCalls++;if(state.resolveCalls===state.switchOnResolve)state.binding=authority(1);return state.binding;},resolveWorkerSession:async()=>{throw new Error('Unused controlled driver session resolver.');},authorizeAction:async()=>true,relayAdapter:adapter,
    createDriver:async({binding})=>{const record={binding,closes:0,clicks:0};drivers.push(record);return {observe:async()=>({title:'Relay fixture',status:'Safe navigation',targets:[{id:'nav_fixture',role:'link',name:'Overview'}]}),click:async()=>{record.clicks++;},fill:async()=>{throw new Error(SECRET);},screenshot:async()=>({mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWJ8AAAAASUVORK5CYII='}),close:async()=>{record.closes++;}};},...options};
  const host=createRelayBrowserHost(hooks),grants=references.map(requestContext=>host.issueGrant({requestContext,ttlMs:60000})),{url}=await host.listen({host:'127.0.0.1',port:0});
  t.after(async()=>{await Promise.allSettled(clients.map(client=>client.close()));await host.close();});
  async function connect(index=0){const client=new Client({name:'combined-relay-fixture-client',version:'0.1.0'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:`Bearer ${grants[index].token}`}}}));return client;}
  return {host,url,grants,references,states,calls,drivers,definitions,adapter,connect};
}

test('combined Relay host lists five safe browser tools and exact five direct Relay tools',async t=>{
  const f=await fixture(t),client=await f.connect(),list=(await client.listTools()).tools;
  assert.equal(list.length,10);assert.deepEqual(list.map(t=>t.name).sort(),['browser_open','browser_observe','browser_click','browser_screenshot','browser_close',...tools().map(t=>t.name)].sort());assert.equal(list.some(t=>t.name==='browser_fill'),false);
  for(const tool of list.filter(t=>t.name.startsWith('relay_fast_'))){assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(JSON.stringify(tool).includes(SECRET),false);}
  assert.equal(f.drivers.length,0);assert.equal(client.getServerVersion().name,'relay-browser-controller');
});
for(const protocol of ['2026-07-28','2025-11-25'])test(`combined raw ${protocol} HTTP discovery publishes all ten fixed schemas and actual combined OAuth scopes`,async t=>{
  const f=await fixture(t),params=protocol==='2026-07-28'?{_meta:{[PROTOCOL_VERSION_META_KEY]:protocol,[CLIENT_CAPABILITIES_META_KEY]:{}}}:{};
  const response=await fetch(f.url,{method:'POST',headers:{authorization:`Bearer ${f.grants[0].token}`,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':protocol,...(protocol==='2026-07-28'?{'mcp-method':'tools/list'}:{})},body:JSON.stringify({jsonrpc:'2.0',id:17,method:'tools/list',params})});
  const text=await response.text();assert.equal(response.status,200,text);
  const wire=JSON.parse(text.startsWith('event:')?text.split('\n').find(line=>line.startsWith('data: ')).slice(6):text);assert.equal(wire.error,undefined);
  assert.deepEqual(wire.result.tools,[...relayBrowserToolDescriptors,...relayDirectToolDescriptors]);
  assert.equal(JSON.stringify(wire.result.tools).includes(SECRET),false);assert.equal(f.calls.length,0);assert.equal(f.drivers.length,0);
});
test('combined MCP browser actions still work and remain isolated per worker grant',async t=>{
  const f=await fixture(t),a=await f.connect(0),b=await f.connect(1),first=ok(await a.callTool({name:'browser_open',arguments:{}})),second=ok(await b.callTool({name:'browser_open',arguments:{}}));assert.notEqual(first.sessionId,second.sessionId);errorCode(await b.callTool({name:'browser_observe',arguments:{session_id:first.sessionId}}),'FORBIDDEN');
  ok(await a.callTool({name:'browser_click',arguments:{session_id:first.sessionId,observation_id:first.observation.id,target_id:'nav_fixture'}}));assert.equal(f.drivers[0].clicks,1);assert.equal(f.drivers[1].clicks,0);
});
test('direct tools receive only original host reference and schema arguments, never the MCP grant credential',async t=>{
  const f=await fixture(t),a=await f.connect(0),b=await f.connect(1);
  assert.equal(ok(await a.callTool({name:'relay_fast_identity',arguments:{}})).user.id,A);assert.equal(ok(await b.callTool({name:'relay_fast_identity',arguments:{}})).user.id,B);
  ok(await a.callTool({name:'relay_fast_thread',arguments:{recipient_id:B,before_id:MID}}));ok(await a.callTool({name:'relay_fast_send',arguments:{recipient_id:B,body:'Controlled DM',client_id:CID}}));
  for(const call of f.calls){assert.ok(f.references.includes(call.reference));assert.deepEqual(Object.keys(call.invocation).sort(),['arguments','name']);for(const grant of f.grants)assert.equal(JSON.stringify(call.invocation).includes(grant.token),false);}
  assert.equal(f.calls[0].reference,f.references[0]);assert.equal(f.calls[1].reference,f.references[1]);assert.deepEqual(f.calls[3].invocation.arguments,{recipient_id:B,body:'Controlled DM',client_id:CID});
  assert.equal(f.drivers.length,0);
});
test('all direct read/write tool DTOs are bounded and regenerate text without upstream debug content',async t=>{
  const f=await fixture(t),client=await f.connect();
  for(const invocation of [{name:'relay_fast_identity',arguments:{}},{name:'relay_fast_inbox',arguments:{}},{name:'relay_fast_thread',arguments:{recipient_id:B}},{name:'relay_fast_send',arguments:{recipient_id:B,body:'Approved fixture message',client_id:CID}},{name:'relay_fast_mark_read',arguments:{message_ids:[MID]}}]){
    const result=await client.callTool(invocation);ok(result);assert.equal(result.content[0].text,JSON.stringify(result.structuredContent));assert.equal(JSON.stringify(result).includes(SECRET),false);assert.equal(Object.hasOwn(result,'debug'),false);
  }
});
test('mark-read supports the exact adapter maximum of 100 distinct IDs within bounded Relay SDK input',async t=>{
  const f=await fixture(t),client=await f.connect(),message_ids=Array.from({length:100},(_,i)=>`${String(i).padStart(8,'0')}-5555-4555-8555-555555555555`);const result=ok(await client.callTool({name:'relay_fast_mark_read',arguments:{message_ids}}));assert.equal(result.markedRead,100);assert.equal(f.calls.length,1);
});
test('direct adapter write scope remains independent of browser grant and preserves the other worker scope',async t=>{
  const f=await fixture(t);f.states[0].write=false;const a=await f.connect(0),b=await f.connect(1);ok(await a.callTool({name:'relay_fast_identity',arguments:{}}));errorCode(await a.callTool({name:'relay_fast_send',arguments:{recipient_id:B,body:'Fixture denied write',client_id:CID}}),'FORBIDDEN');ok(await b.callTool({name:'relay_fast_send',arguments:{recipient_id:A,body:'Fixture permitted write',client_id:CID}}));
});
test('unknown properties, account/profile/credential selectors and malformed recipient IDs never reach direct adapter',async t=>{
  const f=await fixture(t),client=await f.connect();
  for(const invocation of [{name:'relay_fast_identity',arguments:{accountId:B}},{name:'relay_fast_inbox',arguments:{token:SECRET}},{name:'relay_fast_thread',arguments:{recipient_id:'Steve'}},{name:'relay_fast_send',arguments:{recipient_id:B,body:'x',client_id:CID,profile:'/tmp/private'}},{name:'relay_fast_mark_read',arguments:{message_ids:[MID,MID]}}]){const result=await client.callTool(invocation);assert.equal(result.isError,true);assert.equal(JSON.stringify(result).includes(SECRET),false);}
  assert.equal(f.calls.length,0);
});
test('direct errors normalize credential-bearing upstream exceptions and returned error messages',async t=>{
  const f=await fixture(t),client=await f.connect();
  for(const [mode,code] of [['throw','INTERNAL'],['safe-error','FORBIDDEN'],['unknown-error','INTERNAL']]){f.states[0].mode=mode;errorCode(await client.callTool({name:'relay_fast_identity',arguments:{}}),code);}
});
test('direct output rejects other-worker identities and accidental credential fields',async t=>{
  const f=await fixture(t),client=await f.connect();for(const mode of ['other-worker','leak-field']){f.states[0].mode=mode;errorCode(await client.callTool({name:'relay_fast_identity',arguments:{}}),'INTERNAL');}
});
test('send success requires the exact authorized payload instead of a different upstream message body',async t=>{
  const f=await fixture(t),client=await f.connect();f.states[0].mode='wrong-body';errorCode(await client.callTool({name:'relay_fast_send',arguments:{recipient_id:B,body:'Authorized fixture payload',client_id:CID}}),'INTERNAL');assert.equal(f.calls.length,1);
});
test('grant authority changing between HTTP authentication and direct hook prevents send before adapter invocation',async t=>{
  const f=await fixture(t),client=await f.connect();ok(await client.callTool({name:'browser_open',arguments:{}}));const state=f.states[0];state.switchOnResolve=state.resolveCalls+2;
  errorCode(await client.callTool({name:'relay_fast_send',arguments:{recipient_id:B,body:'Must never be sent as another worker',client_id:CID}}),'AUTH_REQUIRED');assert.equal(state.resolveCalls,state.switchOnResolve);assert.equal(f.calls.length,0);assert.equal(f.drivers[0].closes,1);
});
test('explicit grant revocation disables direct tools and closes only its previously opened browser',async t=>{
  const f=await fixture(t),a=await f.connect(0),b=await f.connect(1);ok(await a.callTool({name:'browser_open',arguments:{}}));ok(await b.callTool({name:'browser_open',arguments:{}}));await f.host.revokeGrant(f.grants[0].grantId);assert.equal(f.drivers[0].closes,1);assert.equal(f.drivers[1].closes,0);
  await assert.rejects(a.callTool({name:'relay_fast_identity',arguments:{}}));assert.equal(ok(await b.callTool({name:'relay_fast_identity',arguments:{}})).user.id,B);assert.equal(f.calls.length,1);
});
test('revocation inside a direct call fails the post-call live check and discards its private response without deadlock',{timeout:5000},async t=>{
  const f=await fixture(t),client=await f.connect();ok(await client.callTool({name:'browser_open',arguments:{}}));f.states[0].mode='revoke';errorCode(await client.callTool({name:'relay_fast_identity',arguments:{}}),'AUTH_REQUIRED');assert.equal(f.drivers[0].closes,1);assert.equal(f.calls.length,1);
});
test('live resolver failure disables an established direct connection before adapter invocation',async t=>{
  const f=await fixture(t),client=await f.connect();f.states[0].live=false;await assert.rejects(client.callTool({name:'relay_fast_identity',arguments:{}}));assert.equal(f.calls.length,0);
});
test('optional direct adapter omission produces only the fixed five Relay browser tools',async t=>{
  const f=await fixture(t,{relayAdapter:undefined}),client=await f.connect();assert.equal((await client.listTools()).tools.length,5);await assert.rejects(client.callTool({name:'relay_fast_identity',arguments:{}}),/not found/);assert.equal(f.calls.length,0);
});
test('registry and method are captured before later host object mutation',async t=>{
  const f=await fixture(t);f.definitions[0].name='secret_tool';f.definitions[1].inputSchema.additionalProperties=true;f.adapter.callTool=()=>{throw new Error('Mutated adapter must not run.');};const client=await f.connect();const names=(await client.listTools()).tools.map(t=>t.name);assert.ok(names.includes('relay_fast_identity'));assert.equal(names.includes('secret_tool'),false);assert.equal(ok(await client.callTool({name:'relay_fast_identity',arguments:{}})).user.id,A);
});
test('strict trusted registry rejects duplicate/unknown tools, relaxed schemas, authority args or forged annotations at construction',()=>{
  const base={resolveBinding:async()=>authority(),resolveWorkerSession:async()=>({}),authorizeAction:async()=>true,createDriver:async()=>({})};
  for(const modify of [x=>x.pop(),x=>{x[0].name='browser_open';},x=>{x[1].name=x[0].name;},x=>{x[0].inputSchema.additionalProperties=true;},x=>{x[0].inputSchema.properties.token={type:'string'};},x=>{x[0].annotations.readOnlyHint=false;},x=>{x[0].securitySchemes[0].scopes=['relay:write'];},x=>{x[0].inputSchema.$ref='file:///secret';},x=>{x[0].inputSchema.hidden=undefined;},x=>{x[0].inputSchema.hidden=()=>{};},x=>{x[0].inputSchema.cyclic=x[0].inputSchema;}]){const registry=tools();modify(registry);assert.throws(()=>createRelayBrowserHost({...base,relayAdapter:{tools:registry,callTool:async()=>({})}}));}
  assert.throws(()=>createRelayBrowserHost({...base,relayAdapter:{tools:tools(),callTool:async()=>({}),token:SECRET}}));assert.throws(()=>createRelayBrowserHost({...base,relayAdapter:{tools:tools()}}));
});
test('production composition requires explicit hooks and canonical private profile configuration without starting browser or listener',()=>{
  assert.throws(()=>createRelayBrowserHost());const base={resolveBinding:async()=>authority(),resolveWorkerSession:async()=>({}),authorizeAction:async()=>true};assert.throws(()=>createRelayBrowserHost(base));assert.throws(()=>createRelayBrowserHost({...base,profileRoot:'/'}));assert.throws(()=>createRelayBrowserHost({...base,profileRoot:'relative'}));assert.throws(()=>createRelayBrowserHost({...base,createDriver:'model-selected'}));
});
