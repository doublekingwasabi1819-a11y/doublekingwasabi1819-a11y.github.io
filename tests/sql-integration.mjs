#!/usr/bin/env node
// Destructive LOCAL disposable-database test. Requires PostgreSQL and permission
// to run psql as the local postgres OS user. No remote URL or credentials used.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {emptyState,applyOperation} from '../engine.mjs';

const db=process.env.RELAY_TEST_DB||'relay_accounts_test';
if(!/^relay_[a-z_]+_test$/.test(db))throw new Error('Use a disposable local relay_*_test database.');
const args=['-u','postgres','--','psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h','/var/run/postgresql','-d',db];
const literal=x=>"'"+String(x).replaceAll("'","''")+"'";
function sql(input,{fail=false}={}){const r=spawnSync('runuser',args,{input,encoding:'utf8'});if(fail){assert.notEqual(r.status,0);return r.stderr;}if(r.status!==0)throw new Error('PostgreSQL test request failed: '+r.stderr);return r.stdout.trim();}
function statement(action,token='',data={}){return `set role service_role; select public.relay_rpc(${literal(action)},${literal(token)},${literal(JSON.stringify(data))}::jsonb);`;}
const rpc=(action,token='',data={})=>JSON.parse(sql(statement(action,token,data)));
const ok=result=>{assert.equal(result.error,undefined,JSON.stringify(result));return result;};
const error=(result,code)=>assert.equal(result.error?.code,code,JSON.stringify(result));
function asyncSql(input){return new Promise((resolve,reject)=>{const child=spawn('runuser',args);let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(out.trim())):reject(new Error(err)));child.stdin.end(input);});}
let passed=0;
async function check(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
const password='Manager! '+randomBytes(15).toString('hex');
const changedPassword='Updated! '+randomBytes(15).toString('hex');
const workerPassword='Worker! '+randomBytes(15).toString('hex');
const resetPassword='Reset! '+randomBytes(15).toString('hex');
const setupCode=randomBytes(32).toString('hex');
const setupHash=createHash('sha256').update(setupCode).digest('hex');
const state=emptyState('Disposable SQL test');
let manager,worker,other,workerLogin,otherLogin,recoveryCode;

sql('drop function if exists public.relay_rpc(text,text,jsonb); drop schema if exists relay_private cascade;');
sql(readFileSync(new URL('../backend/schema.sql',import.meta.url),'utf8'));

await check('service role status; anon and authenticated RPC/table access denied',()=>{
  assert.deepEqual(rpc('status'),{needsSetup:true,deleted:false});
  for(const role of ['anon','authenticated']){
    assert.match(sql(`set role ${role}; select public.relay_rpc('status');`,{fail:true}),/permission denied/);
    assert.match(sql(`set role ${role}; select * from relay_private.accounts;`,{fail:true}),/permission denied/);
  }
});

await check('setup closed without deployment hash; failed setup persists throttle',()=>{
  error(rpc('setup','',{name:'Owner',username:'manager',password,state,setupCode}),'SETUP_DISABLED');
  sql(`update relay_private.studio set setup_hash=${literal(setupHash)} where singleton;`);
  error(rpc('setup','',{name:'Owner',username:'manager',password,state,setupCode:'wrong',rateKey:'test-ip'}),'AUTH');
  assert.equal(Number(sql("select sum(attempts) from relay_private.throttle where bucket like 'setup:%';")),2);
});

await check('concurrent setup creates exactly one manager and consumes setup secret',async()=>{
  const input=statement('setup','',{setupCode,name:'Owner',username:'manager',password,state,rateKey:'setup-success'});
  const results=await Promise.all([asyncSql(input),asyncSql(input)]);
  manager=ok(results.find(x=>x.token));recoveryCode=manager.recoveryCode;
  error(results.find(x=>x.error),'SETUP_CLOSED');
  assert.equal(Number(sql("select count(*) from relay_private.accounts where role='manager';")),1);
  assert.equal(sql('select setup_hash is null from relay_private.studio;'),'t');
  assert.equal(manager.token.length,64);assert.equal(recoveryCode.length,64);
});

await check('password lengths use UTF-8 bytes and preserve spaces',()=>{
  const login=ok(rpc('login','',{role:'manager',username:'  MANAGER  ',password,rateKey:'login-good'}));
  ok(rpc('logout',login.token));
  for(const bad of ['short','x'.repeat(73),'😀'.repeat(19)]){
    error(rpc('workers.create',manager.token,{name:'Invalid',username:'invalid',password:bad}),'VALIDATION');
  }
  const spaced='  original password  ';
  const temporary=ok(rpc('workers.create',manager.token,{name:'Spaces',username:'spaces',password:spaced}));
  error(rpc('login','',{role:'worker',username:'spaces',password:spaced.trim(),rateKey:'space-trim'}),'AUTH');
  ok(rpc('login','',{role:'worker',username:'spaces',password:spaced,rateKey:'space-good'}));
  ok(rpc('workers.delete',manager.token,{workerId:temporary.id,currentPassword:password,confirmation:'spaces'}));
});

await check('worker slots create distinct agents; role cannot be forged',()=>{
  worker=ok(rpc('workers.create',manager.token,{name:'Forge',username:'forge',password:workerPassword,workRole:'Builder',model:'Example'}));
  other=ok(rpc('workers.create',manager.token,{name:'Scout',username:'scout',password:workerPassword,workRole:'Tester'}));
  assert.notEqual(worker.id,worker.agentId);
  error(rpc('login','',{role:'manager',username:'forge',password:workerPassword,rateKey:'wrong-role'}),'AUTH');
  workerLogin=ok(rpc('login','',{role:'worker',username:'forge',password:workerPassword,rateKey:'forge'}));
  otherLogin=ok(rpc('login','',{role:'worker',username:'scout',password:workerPassword,rateKey:'scout'}));
  const context=ok(rpc('context',workerLogin.token));
  assert.equal(context.actor.id,worker.agentId);assert.equal(context.actor.owner,false);
  assert.deepEqual(context.workers,[]);
  for(const action of ['workers.create','workers.reset','workers.delete','password.change','workspace.delete'])
    error(rpc(action,workerLogin.token,{owner:true,role:'manager',workerId:other.id,currentPassword:password}),'FORBIDDEN');
});

await check('private room isolation, manager access, and stale version rejection',()=>{
  const room=ok(rpc('room.save',workerLogin.token,{body:'Private Forge notes',expectedVersion:0}));
  assert.equal(room.version,1);
  error(rpc('room.read',otherLogin.token,{accountId:worker.id}),'FORBIDDEN');
  error(rpc('room.save',otherLogin.token,{accountId:worker.id,body:'Overwrite',expectedVersion:1}),'FORBIDDEN');
  error(rpc('room.save',workerLogin.token,{body:'Stale',expectedVersion:0}),'CONFLICT');
  assert.equal(ok(rpc('room.read',manager.token,{accountId:worker.id})).body,'Private Forge notes');
  assert.equal(ok(rpc('context',otherLogin.token)).room.body,'');
  const serialized=JSON.stringify(ok(rpc('context',manager.token)));
  for(const forbidden of ['password_hash','recovery_hash','token_hash','Private Forge notes'])assert.ok(!serialized.includes(forbidden));
});

await check('wrong reauthentication retains session; correct worker reset revokes and rotates',()=>{
  let context=ok(rpc('context',workerLogin.token));
  const originalRun=context.actor.session;
  let next=applyOperation(context.state,{id:'test-task',type:'task.add',payload:{title:'Claim test',acceptance:'Passed'}},{id:'owner',owner:true});
  ok(rpc('board.commit',manager.token,{expectedRevision:context.state.revision,state:next}));
  context=ok(rpc('context',workerLogin.token));
  next=applyOperation(context.state,{id:'test-claim',type:'task.claim',payload:{taskId:'test-task'}},context.actor);
  ok(rpc('board.commit',workerLogin.token,{expectedRevision:context.state.revision,state:next}));
  error(rpc('workers.reset',manager.token,{workerId:worker.id,currentPassword:'Incorrect manager password',newPassword:resetPassword}),'AUTH');
  ok(rpc('context',manager.token));
  ok(rpc('workers.reset',manager.token,{workerId:worker.id,currentPassword:password,newPassword:resetPassword}));
  error(rpc('context',workerLogin.token),'SESSION');
  error(rpc('login','',{role:'worker',username:'forge',password:workerPassword,rateKey:'old-worker-password'}),'AUTH');
  workerLogin=ok(rpc('login','',{role:'worker',username:'forge',password:resetPassword,rateKey:'reset-worker'}));
  context=ok(rpc('context',workerLogin.token));
  assert.notEqual(context.actor.session,originalRun);
  assert.equal(context.state.tasks.find(t=>t.id==='test-task').session,context.actor.session);
  const another=ok(rpc('login','',{role:'worker',username:'forge',password:resetPassword,rateKey:'same-run'}));
  assert.equal(ok(rpc('context',another.token)).actor.session,context.actor.session);
});

await check('board CAS rejects stale account snapshots; run replacement fences old login',()=>{
  const old=ok(rpc('context',manager.token));
  ok(rpc('workers.update',manager.token,{workerId:other.id,name:'Scout two'}));
  let next=applyOperation(old.state,{id:'stale-post',type:'message.add',payload:{body:'Outdated'}},old.actor);
  error(rpc('board.commit',manager.token,{expectedRevision:old.state.revision,state:next}),'CONFLICT');
  const context=ok(rpc('context',manager.token));
  next=applyOperation(context.state,{id:'replacement-run',type:'agent.session',payload:{agentId:worker.agentId}},context.actor);
  ok(rpc('board.commit',manager.token,{expectedRevision:context.state.revision,state:next}));
  error(rpc('context',workerLogin.token),'STALE_SESSION');
  workerLogin=ok(rpc('login','',{role:'worker',username:'forge',password:resetPassword,rateKey:'replacement-login'}));
  assert.equal(ok(rpc('context',workerLogin.token)).actor.session,'replacement-run');
});

await check('board commit cannot alter account-owned agent metadata',()=>{
  const context=ok(rpc('context',manager.token));
  const next=structuredClone(context.state);next.revision++;
  next.agents.find(a=>a.id===worker.agentId).name='Forged';
  error(rpc('board.commit',manager.token,{expectedRevision:context.state.revision,state:next}),'ACCOUNT_CONFLICT');
});

await check('disabling worker invalidates old session after re-enable',()=>{
  ok(rpc('workers.update',manager.token,{workerId:other.id,enabled:false}));
  error(rpc('context',otherLogin.token),'SESSION');
  error(rpc('login','',{role:'worker',username:'scout',password:workerPassword,rateKey:'paused'}),'AUTH');
  ok(rpc('workers.update',manager.token,{workerId:other.id,enabled:true}));
  error(rpc('context',otherLogin.token),'SESSION');
  otherLogin=ok(rpc('login','',{role:'worker',username:'scout',password:workerPassword,rateKey:'enabled'}));
});

await check('persistent login throttle uses normalized account across client keys',()=>{
  for(let i=0;i<10;i++)error(rpc('login','',{role:'worker',username:'does-not-exist',password,rateKey:'distinct-ip-'+i}),'AUTH');
  error(rpc('login','',{role:'worker',username:'  DOES-NOT-EXIST  ',password,rateKey:'new-ip'}),'RATE_LIMIT');
  assert.equal(Number(sql("select attempts from relay_private.throttle where bucket='login:account:'||relay_private.digest_token('does-not-exist');")),10);
});

await check('recovery code single-use; manager password change revokes sessions',()=>{
  error(rpc('recovery.reset','',{username:'manager',recoveryCode:'0'.repeat(64),newPassword:changedPassword,rateKey:'bad-recovery'}),'AUTH');
  const recovered=ok(rpc('recovery.reset','',{username:'manager',recoveryCode,newPassword:changedPassword,rateKey:'recovery'}));
  error(rpc('context',manager.token),'SESSION');
  error(rpc('recovery.reset','',{username:'manager',recoveryCode,newPassword:password,rateKey:'reused-recovery'}),'AUTH');
  recoveryCode=recovered.recoveryCode;
  manager=ok(rpc('login','',{role:'manager',username:'manager',password:changedPassword,rateKey:'recovered-login'}));
  ok(rpc('password.change',manager.token,{currentPassword:changedPassword,newPassword:password}));
  error(rpc('context',manager.token),'SESSION');
  manager=ok(rpc('login','',{role:'manager',username:'manager',password,rateKey:'changed-login'}));
  const rotated=ok(rpc('recovery.rotate',manager.token,{currentPassword:password}));
  error(rpc('recovery.reset','',{username:'manager',recoveryCode,newPassword:password,rateKey:'rotated-code'}),'AUTH');
  assert.notEqual(rotated.recoveryCode,recoveryCode);
});

await check('worker deletion wipes private data, preserves tombstone, releases task',()=>{
  error(rpc('workers.delete',manager.token,{workerId:worker.id,currentPassword:password,confirmation:'wrong'}),'CONFIRMATION');
  ok(rpc('workers.delete',manager.token,{workerId:worker.id,currentPassword:password,confirmation:'forge'}));
  error(rpc('context',workerLogin.token),'SESSION');
  error(rpc('room.read',manager.token,{accountId:worker.id}),'NOT_FOUND');
  const context=ok(rpc('context',manager.token));
  assert.equal(context.state.agents.find(a=>a.id===worker.agentId).name,'Deleted worker');
  assert.equal(context.state.tasks.find(t=>t.id==='test-task').owner,null);
  assert.equal(context.state.tasks.find(t=>t.id==='test-task').status,'ready');
  assert.ok(context.workers.every(w=>w.id!==worker.id));
});

await check('full deletion wipes application data and remains closed after reinstall',()=>{
  error(rpc('workspace.delete',manager.token,{currentPassword:password,confirmation:'delete'}),'CONFIRMATION');
  ok(rpc('workspace.delete',manager.token,{currentPassword:password,confirmation:'DELETE MY STUDIO'}));
  assert.deepEqual(rpc('status'),{needsSetup:false,deleted:true});
  error(rpc('context',manager.token),'DELETED');
  error(rpc('setup','',{setupCode,name:'Attacker',username:'other-manager',password,state}),'DELETED');
  for(const table of ['accounts','rooms','sessions','throttle'])assert.equal(Number(sql(`select count(*) from relay_private.${table};`)),0);
  assert.equal(sql('select state is null and setup_hash is null from relay_private.studio;'),'t');
  sql(readFileSync(new URL('../backend/schema.sql',import.meta.url),'utf8'));
  assert.deepEqual(rpc('status'),{needsSetup:false,deleted:true});
});

console.log(`${passed} PostgreSQL integration checks passed in disposable ${db}.`);
