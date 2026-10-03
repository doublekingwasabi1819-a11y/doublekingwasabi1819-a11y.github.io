import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserGrants} from '../grants.mjs';

const alpha={workspaceId:'fixture-grants',accountId:'11111111-1111-4111-8111-111111111111',agentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',runId:'run-alpha'};
const beta={...alpha,accountId:'22222222-2222-4222-8222-222222222222',agentId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',runId:'run-beta'};
const credential='controlled_fixture_token_000000000000000001';
const request=token=>new Request('http://localhost/mcp',{headers:{authorization:'Bearer '+token}});
const denied=error=>error.code==='AUTH_REQUIRED'&&!error.message.includes('private');
async function setup(t,options={}){
 const reference=Object.freeze({hostReference:'fixture-only'}),retired=[];let time=1000,calls=0,binding=alpha;
 const grants=createBrowserGrants({now:()=>time,resolveBinding:async context=>{calls++;assert.equal(context,reference);if(binding instanceof Error)throw binding;return binding;},onRevoke:async context=>retired.push(context),...options});
 t.after(()=>grants.close());
 const grant=grants.issue({requestContext:reference,token:credential,ttlMs:1000});
 return {grants,grant,reference,retired,setTime:value=>{time=value;},setBinding:value=>{binding=value;},calls:()=>calls};
}

test('grants expose only stable authority-free per-grant contexts and canonical live bindings',async t=>{
 const f=await setup(t),a=await f.grants.authenticate(request(f.grant.token)),b=await f.grants.authenticate(request(f.grant.token));
 assert.equal(a.principalId,f.grant.grantId);assert.equal(a.requestContext,b.requestContext);assert.ok(Object.isFrozen(a.requestContext));
 assert.deepEqual(Object.keys(a.requestContext),['grantId']);assert.equal(JSON.stringify(a).includes(credential),false);
 assert.deepEqual(await f.grants.authorize(a.requestContext),alpha);assert.equal(f.calls(),3);
 let original;await f.grants.withContext(a.requestContext,reference=>{original=reference;return true;});assert.equal(original,f.reference);
});

test('unknown or forged contexts and credentials cannot resolve host identity or trigger cleanup',async t=>{
 const f=await setup(t);
 for(const context of [undefined,{},Object.freeze({grantId:f.grant.grantId})])await assert.rejects(f.grants.authorize(context),denied);
 for(const token of ['', 'short', 'different_fixture_token_00000000000001'])await assert.rejects(f.grants.authenticate(request(token)),denied);
 assert.equal(f.calls(),0);assert.equal(f.retired.length,0);
});

test('expiry retires only the owned verified context and invalidates all later access',async t=>{
 const f=await setup(t),identity=await f.grants.authenticate(request(f.grant.token));f.setTime(2000);
 await assert.rejects(f.grants.authenticate(request(f.grant.token)),denied);
 assert.deepEqual(f.retired,[identity.requestContext]);assert.equal(f.calls(),1);
 await assert.rejects(f.grants.authorize(identity.requestContext),denied);
 await assert.rejects(f.grants.authenticate(request(f.grant.token)),denied);assert.equal(f.retired.length,1);
});

test('grant count, TTL, duplicate credential and original context validation are bounded',async t=>{
 const f=await setup(t,{maxGrants:1});
 assert.throws(()=>f.grants.issue({requestContext:f.reference}),/bounded trusted MCP grant/);
 for(const ttlMs of [0,999,86400001,NaN])assert.throws(()=>f.grants.issue({requestContext:f.reference,ttlMs}));
 await f.grants.revoke(f.grant.grantId);
 const next=f.grants.issue({requestContext:f.reference});assert.notEqual(next.token,credential);
 assert.throws(()=>f.grants.issue({requestContext:null}));
 const other=createBrowserGrants({resolveBinding:async()=>alpha,onRevoke:async()=>{}});t.after(()=>other.close());
 other.issue({requestContext:{},token:credential});assert.throws(()=>other.issue({requestContext:{},token:credential}),/distinct MCP grant/);
});

test('revoked credentials cannot be reissued and lifetime issuance history remains bounded',async t=>{
 const f=await setup(t,{maxGrants:1,maxIssuances:2});await f.grants.revoke(f.grant.grantId);
 assert.throws(()=>f.grants.issue({requestContext:f.reference,token:credential}),/distinct MCP grant/);
 const second=f.grants.issue({requestContext:f.reference});await f.grants.revoke(second.grantId);
 assert.throws(()=>f.grants.issue({requestContext:f.reference}),/bounded trusted MCP grant/);
 await assert.rejects(f.grants.authenticate(request(credential)),denied);
 await assert.rejects(f.grants.authenticate(request(second.token)),denied);
});

test('a grant cannot inherit a different account, agent, workspace or run',async t=>{
 for(const changed of [beta,{...alpha,agentId:beta.agentId},{...alpha,workspaceId:'other-workspace'},{...alpha,runId:'replacement-run'}]){
  const f=await setup(t),identity=await f.grants.authenticate(request(f.grant.token));f.setBinding(changed);
  await assert.rejects(f.grants.authenticate(request(f.grant.token)),denied);
  assert.deepEqual(f.retired,[identity.requestContext]);await assert.rejects(f.grants.authorize(identity.requestContext),denied);
 }
});

test('canonical binding is snapshotted and resolver mutation cannot change existing grant authority',async t=>{
 const mutable={...alpha,accountId:alpha.accountId.toUpperCase(),agentId:alpha.agentId.toUpperCase()};
 const f=await setup(t);f.setBinding(mutable);const identity=await f.grants.authenticate(request(f.grant.token));
 const first=await f.grants.authorize(identity.requestContext);assert.ok(Object.isFrozen(first));assert.deepEqual(first,alpha);
 mutable.runId='mutated-run';await assert.rejects(f.grants.authorize(identity.requestContext),denied);
 assert.equal(first.runId,alpha.runId);
});

test('authorization invalidation schedules retirement without waiting on the action queue',async t=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});let retiredContext;
 const f=await setup(t,{onRevoke:async context=>{retiredContext=context;await gate;}}),identity=await f.grants.authenticate(request(f.grant.token));
 f.setBinding(new Error('private-downstream-error'));
 let deadline;try{
  await Promise.race([assert.rejects(f.grants.authorize(identity.requestContext),denied),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Authorization waited on its own cleanup queue.')),250);})]);
  assert.equal(retiredContext,identity.requestContext);
 }finally{clearTimeout(deadline);release();}
});

test('failed retirement keeps capacity quarantined, denies credentials and permits confirmed cleanup retry',async t=>{
 let failing=true,attempts=0;
 const f=await setup(t,{maxGrants:1,onRevoke:async()=>{attempts++;if(failing)throw new Error('private-controlled-teardown-failure');}});
 await f.grants.authenticate(request(f.grant.token));
 await assert.rejects(f.grants.revoke(f.grant.grantId),/Browser grant cleanup failed\./);
 await assert.rejects(f.grants.authenticate(request(f.grant.token)),denied);
 assert.throws(()=>f.grants.issue({requestContext:f.reference}),/bounded trusted MCP grant/);
 failing=false;await f.grants.revoke(f.grant.grantId);assert.equal(attempts,2);
 const next=f.grants.issue({requestContext:f.reference});assert.notEqual(next.token,credential);
 await assert.rejects(f.grants.authenticate(request(f.grant.token)),denied);
});

test('concurrent retirement waits share one attempt and receive only normalized cleanup errors',async t=>{
 let release,failing=true,attempts=0;const gate=new Promise(resolve=>{release=resolve;});
 const f=await setup(t,{onRevoke:async()=>{attempts++;await gate;if(failing)throw new Error('private-controlled-teardown-failure');}});
 await f.grants.authenticate(request(f.grant.token));
 const first=f.grants.revoke(f.grant.grantId),second=f.grants.revoke(f.grant.grantId);
 const outcomes=Promise.allSettled([first,second]);release();
 for(const result of await outcomes){assert.equal(result.status,'rejected');assert.equal(result.reason.message,'Browser grant cleanup failed.');}
 assert.equal(attempts,1);failing=false;await f.grants.revoke(f.grant.grantId);assert.equal(attempts,2);
});

test('failed close retains cleanup work and a later close can confirm teardown safely',async t=>{
 let failing=true,attempts=0;
 const f=await setup(t,{onRevoke:async()=>{attempts++;if(failing)throw new Error('private-controlled-teardown-failure');}});
 await f.grants.authenticate(request(f.grant.token));await assert.rejects(f.grants.close(),/Browser grant cleanup failed\./);
 await assert.rejects(f.grants.authenticate(request(f.grant.token)),denied);assert.throws(()=>f.grants.issue({requestContext:f.reference}));
 failing=false;await f.grants.close();assert.equal(attempts,2);await f.grants.close();assert.equal(attempts,2);
});

test('closing grants retires existing contexts and prevents new issuance and authentication',async t=>{
 const f=await setup(t),identity=await f.grants.authenticate(request(f.grant.token));await f.grants.close();
 assert.deepEqual(f.retired,[identity.requestContext]);
 assert.throws(()=>f.grants.issue({requestContext:f.reference}));await assert.rejects(f.grants.authenticate(request(f.grant.token)),denied);
});
