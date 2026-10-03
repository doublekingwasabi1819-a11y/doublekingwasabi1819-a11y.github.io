import test from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createPrivateBrowserHost,createFixtureHost,startFixtureCli} from '../serve.mjs';

// Real localhost HTTP and official SDK transport; every browser, worker account,
// action hook, and PNG is our controlled fixture. No actual Chromium or Relay
// credentials are used and no listener binds outside loopback.
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWJ8AAAAASUVORK5CYII=','base64');
const PRIVATE='host-fixture-private-token-password-profile-path';
const authorities=[
  {workspaceId:'private-host-fixture',accountId:'11111111-1111-4111-8111-111111111111',agentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',runId:'run-a'},
  {workspaceId:'private-host-fixture',accountId:'22222222-2222-4222-8222-222222222222',agentId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',runId:'run-b'}
];
const ok=result=>{assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent;};
const errorCode=(result,code)=>{assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,code);assert.ok(!JSON.stringify(result).includes(PRIVATE));};
async function fixture(t,options={}){
  const references=authorities.map((_,index)=>Object.freeze({worker:index,private:PRIVATE}));
  const states=references.map((reference,index)=>({reference,binding:{...authorities[index]},live:true,actions:new Set(['browser_open','browser_click','browser_fill','browser_close']),revokeOnAction:false}));
  const actions=[],drivers=[],clients=[];let authCalls=0;
  const host=createPrivateBrowserHost({target:options.target||'fixture',
    resolveBinding:async reference=>{authCalls++;const state=states.find(value=>value.reference===reference);if(!state?.live)throw new Error(PRIVATE);return state.binding;},
    authorizeAction:async(action,reference)=>{const state=states.find(value=>value.reference===reference);actions.push({action,reference});if(state?.revokeOnAction)state.live=false;return state?.actions.has(action.name)===true;},
    createDriver:async({binding})=>{
      const record={binding,observations:0,screenshots:0,clicks:0,fills:0,closes:0,current:new Set()};drivers.push(record);
      return {
        async observe(){record.observations++;record.current=new Set([`button_${record.observations}`,`note_${record.observations}`]);return {title:'Private fixture',status:`Clicks ${record.clicks}`,targets:[{id:`button_${record.observations}`,role:'button',name:'Fixture click'},{id:`note_${record.observations}`,role:'textbox',name:'Fixture note'}]};},
        async click(id){assert.ok(record.current.has(id),'Driver must act on current observed node');record.clicks++;record.current.clear();},
        async fill(id,text){assert.ok(record.current.has(id));assert.equal(typeof text,'string');record.fills++;record.current.clear();},
        async screenshot(){record.screenshots++;return {mimeType:'image/png',data:PNG.toString('base64')};},
        async close(){record.closes++;record.current.clear();}
      };
    },...options.hostOptions});
  const grants=references.map(requestContext=>host.issueGrant({requestContext,ttlMs:60000}));
  const {url}=await host.listen({host:'127.0.0.1',port:0});
  const origin=new URL(url).origin;
  t.after(async()=>{await Promise.allSettled(clients.map(client=>client.close()));await host.close();});
  async function connect(index=0){const client=new Client({name:'private-host-fixture-client',version:'0.1.0'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:`Bearer ${grants[index].token}`}}}));return client;}
  function request(path,{index=0,authorized=true,method='GET',body,headers={}}={}){return fetch(new URL(path,origin),{method,headers:{...(authorized?{authorization:`Bearer ${grants[index].token}`} : {}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});}
  return {host,url,origin,connect,request,grants,references,states,actions,drivers,get authCalls(){return authCalls;}};
}

test('private host public viewer is static and contains no granted credential, account identity or browser state',async t=>{
  const f=await fixture(t),response=await f.request('/viewer',{authorized:false});assert.equal(response.status,200);const html=await response.text();
  assert.match(html,/Connection token/);assert.match(html,/Masked browser screen/);assert.match(html,/type="password"/);
  for(const secret of [PRIVATE,...f.grants.map(g=>g.token),...authorities.map(a=>a.accountId),...authorities.map(a=>a.agentId)])assert.equal(html.includes(secret),false);
  assert.equal(f.authCalls,0);assert.equal(f.drivers.length,0);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(html,/<meta name="referrer" content="no-referrer">/);assert.match(response.headers.get('content-security-policy'),/script-src 'sha256-/);
});
test('MCP and private viewer operations require a grant, while public HTML does not grant browser access',async t=>{
  const f=await fixture(t);
  for(const [path,method,body] of [['/mcp','POST',{jsonrpc:'2.0',id:1,method:'ping'}],['/viewer/open','POST',{}],['/viewer/snapshot','GET',undefined]]){const response=await f.request(path,{authorized:false,method,body});assert.equal(response.status,401);assert.ok(!(await response.text()).includes(PRIVATE));}
  assert.equal(f.drivers.length,0);assert.equal(f.authCalls,0);
  assert.equal((await f.request('/viewer/snapshot?session_id=victim')).status,404);
});
test('two worker grants discover tools and own separate browser sessions through real MCP transport',async t=>{
  const f=await fixture(t),a=await f.connect(0),b=await f.connect(1);assert.equal((await a.listTools()).tools.length,6);assert.equal((await b.listTools()).tools.length,6);
  const first=ok(await a.callTool({name:'browser_open',arguments:{}})),second=ok(await b.callTool({name:'browser_open',arguments:{}}));assert.notEqual(first.sessionId,second.sessionId);assert.equal(f.drivers.length,2);
  assert.equal(f.drivers[0].binding.accountId,authorities[0].accountId);assert.equal(f.drivers[1].binding.accountId,authorities[1].accountId);
  errorCode(await b.callTool({name:'browser_observe',arguments:{session_id:first.sessionId}}),'FORBIDDEN');assert.equal(f.drivers[0].closes,0);assert.equal(f.drivers[1].closes,0);
});
test('viewer open accepts no session/account/tool selectors and returns only open state',async t=>{
  const f=await fixture(t);for(const body of [{session_id:'victim'},{accountId:authorities[1].accountId},{url:'https://elsewhere.invalid/'},[],null])assert.equal((await f.request('/viewer/open',{method:'POST',body})).status,400);
  assert.equal(f.drivers.length,0);const response=await f.request('/viewer/open',{method:'POST',body:{}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{state:'open'});assert.equal(f.drivers.length,1);
  assert.equal((await f.request('/viewer/open')).status,405);assert.equal((await f.request('/viewer/open',{method:'POST',body:{},headers:{origin:'https://elsewhere.invalid'}})).status,403);
});
test('viewer snapshot is a private PNG with no browser or observation selector and never refreshes agent targets',async t=>{
  const f=await fixture(t),client=await f.connect(),opened=ok(await client.callTool({name:'browser_open',arguments:{}}));const observed=f.drivers[0].observations;
  for(let index=0;index<2;index++){const response=await f.request('/viewer/snapshot');assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await response.arrayBuffer()),PNG);assert.equal(response.headers.get('set-cookie'),null);}
  assert.equal(f.drivers[0].observations,observed);assert.equal(f.drivers[0].screenshots,2);
  const clicked=ok(await client.callTool({name:'browser_click',arguments:{session_id:opened.sessionId,observation_id:opened.observation.id,target_id:opened.observation.targets[0].id}}));assert.equal(clicked.observation.status,'Clicks 1');assert.equal(f.drivers[0].clicks,1);
});
test('one worker viewer cannot choose another browser and does not create a browser without explicit open action',async t=>{
  const f=await fixture(t),client=await f.connect(0);ok(await client.callTool({name:'browser_open',arguments:{}}));assert.equal((await f.request('/viewer/snapshot',{index:1})).status,404);assert.equal(f.drivers.length,1);
  assert.equal((await f.request('/viewer/open',{index:1,method:'POST',body:{}})).status,200);assert.equal(f.drivers.length,2);assert.equal((await f.request('/viewer/snapshot',{index:1})).status,200);assert.equal(f.drivers[0].screenshots,0);assert.equal(f.drivers[1].screenshots,1);
});
test('per-grant action decisions receive the exact trusted reference and current binding',async t=>{
  const f=await fixture(t);f.states[1].actions=new Set(['browser_open','browser_close']);const a=await f.connect(0),b=await f.connect(1),first=ok(await a.callTool({name:'browser_open',arguments:{}})),second=ok(await b.callTool({name:'browser_open',arguments:{}}));
  const args=o=>({session_id:o.sessionId,observation_id:o.observation.id,target_id:o.observation.targets[0].id});ok(await a.callTool({name:'browser_click',arguments:args(first)}));errorCode(await b.callTool({name:'browser_click',arguments:args(second)}),'FORBIDDEN');
  assert.equal(f.drivers[0].clicks,1);assert.equal(f.drivers[1].clicks,0);
  const calls=f.actions.filter(call=>call.action.name==='browser_click');assert.equal(calls[0].reference,f.references[0]);assert.equal(calls[1].reference,f.references[1]);assert.equal(calls[0].action.binding.accountId,authorities[0].accountId);assert.equal(calls[1].action.binding.accountId,authorities[1].accountId);
  f.states[1].actions.clear();assert.equal((await f.request('/viewer/open',{index:1,method:'POST',body:{}})).status,403);
});
test('explicit grant revocation immediately closes its verified browser and leaves the other worker live',async t=>{
  const f=await fixture(t),a=await f.connect(0),b=await f.connect(1);ok(await a.callTool({name:'browser_open',arguments:{}}));const second=ok(await b.callTool({name:'browser_open',arguments:{}}));
  await f.host.revokeGrant(f.grants[0].grantId);assert.equal(f.drivers[0].closes,1);assert.equal(f.drivers[1].closes,0);assert.equal((await f.request('/viewer/snapshot')).status,401);
  ok(await b.callTool({name:'browser_observe',arguments:{session_id:second.sessionId}}));assert.equal(f.drivers[1].closes,0);await f.host.revokeGrant(f.grants[0].grantId);assert.equal(f.drivers[0].closes,1);
});
test('a fresh binding resolver failure rejects an existing grant and completes its browser cleanup',async t=>{
  const f=await fixture(t),client=await f.connect();ok(await client.callTool({name:'browser_open',arguments:{}}));f.states[0].live=false;
  const response=await f.request('/viewer/snapshot');assert.equal(response.status,401);assert.ok(!(await response.text()).includes(PRIVATE));assert.equal(f.drivers[0].closes,1);assert.equal((await f.request('/viewer/open',{method:'POST',body:{}})).status,401);
});
test('a grant cannot silently inherit a changed downstream worker/run authority',async t=>{
  const f=await fixture(t),client=await f.connect();ok(await client.callTool({name:'browser_open',arguments:{}}));f.states[0].binding={...authorities[0],runId:'new-worker-run'};
  assert.equal((await f.request('/viewer/snapshot')).status,401);assert.equal(f.drivers[0].closes,1);
});
test('revocation discovered during a queued controller action does not deadlock lifecycle cleanup', {timeout:5000},async t=>{
  const f=await fixture(t),client=await f.connect(),opened=ok(await client.callTool({name:'browser_open',arguments:{}}));f.states[0].revokeOnAction=true;
  const result=await client.callTool({name:'browser_click',arguments:{session_id:opened.sessionId,observation_id:opened.observation.id,target_id:opened.observation.targets[0].id}});
  errorCode(result,'AUTH_REQUIRED');assert.equal(f.drivers[0].clicks,0);assert.equal(f.drivers[0].closes,1);assert.equal((await f.request('/viewer/snapshot')).status,401);await f.host.revokeGrant(f.grants[0].grantId);assert.equal(f.drivers[0].closes,1);
});
test('host close retires every grant and browser without exposing authority or accepting later requests',async t=>{
  const f=await fixture(t),a=await f.connect(0),b=await f.connect(1);ok(await a.callTool({name:'browser_open',arguments:{}}));ok(await b.callTool({name:'browser_open',arguments:{}}));await f.host.close();assert.deepEqual(f.drivers.map(record=>record.closes),[1,1]);
  assert.equal((await f.host.fetch(new Request(f.origin+'/viewer'))).status,503);assert.throws(()=>f.host.issueGrant({requestContext:f.references[0]}));
});
test('private host composition rejects authority overrides and non-loopback listeners before use',async()=>{
  const hooks={resolveBinding:async()=>authorities[0],authorizeAction:async()=>true,createDriver:async()=>({})};
  for(const httpOptions of [{authenticate(){}},{controller:{}},{serverFactory(){}},{routes:{}},{publicRoutes:{}}])assert.throws(()=>createPrivateBrowserHost({...hooks,httpOptions}));
  for(const controllerOptions of [{authorize(){}},{authorizeAction(){}},{createDriver(){}}])assert.throws(()=>createPrivateBrowserHost({...hooks,controllerOptions}));
  const host=createPrivateBrowserHost(hooks);try{await assert.rejects(host.listen({host:'0.0.0.0',port:0}));await assert.rejects(host.listen({host:'192.168.0.1',port:0}));}finally{await host.close();}
});
test('fixture host rejects invalid credentials without issuing or listening on a grant',()=>{
  for(const token of [undefined,'','short','x'.repeat(129),'a'.repeat(32)+' secret','Bearer '+'a'.repeat(32)])assert.throws(()=>createFixtureHost({token,createDriver:async()=>{throw new Error('Browser should not be reached.');}}),/separate fixture MCP token/);
});
test('fixture CLI requires exact opt-in and complete private environment before any listener or output',async()=>{
  let wrote=false;const output={write(){wrote=true;}};
  for(const args of [[],['--relay'],['--fixture','--host','0.0.0.0'],['--fixture','--fixture']])await assert.rejects(startFixtureCli({args,env:{},output}),/Use --fixture/);
  for(const env of [{},{RELAY_BROWSER_PROFILES:'/tmp/test-fixture-private'},{RELAY_BROWSER_PROFILES:'/tmp/test-fixture-private',RELAY_FIXTURE_MCP_TOKEN:'short'},{RELAY_BROWSER_PROFILES:'/tmp/test-fixture-private',RELAY_FIXTURE_MCP_TOKEN:'a'.repeat(32),RELAY_BROWSER_PORT:'0'},{RELAY_BROWSER_PROFILES:'/tmp/test-fixture-private',RELAY_FIXTURE_MCP_TOKEN:'a'.repeat(32),RELAY_BROWSER_PORT:'65536'}])await assert.rejects(startFixtureCli({args:['--fixture'],env,output}));
  assert.equal(wrote,false);
});
