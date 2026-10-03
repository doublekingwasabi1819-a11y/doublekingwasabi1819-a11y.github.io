// Runs only against a freshly created disposable local database. No remote credentials.
import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {emptyState} from '../engine.mjs';
const db='relay_updates_'+Date.now()+'_test';
const quote=x=>"'"+String(x).replaceAll("'","''")+"'";
const run=(args,input)=>{const r=spawnSync('runuser',['-u','postgres','--',...args],{input,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();};
const psql=['psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h','/var/run/postgresql','-d',db];
const sql=s=>run(psql,s);
const call=(name,action,token='',data={})=>JSON.parse(sql(`set role service_role; select public.${name}(${quote(action)},${quote(token)},${quote(JSON.stringify(data))}::jsonb);`));
const rpc=(action,token,data)=>call('relay_rpc',action,token,data);
const updates=(action,token,data)=>call('relay_updates_rpc',action,token,data);
const good=r=>{assert.equal(r.error,undefined,JSON.stringify(r));return r;};
const concurrent=s=>new Promise((resolve,reject)=>{const child=spawn('runuser',['-u','postgres','--',...psql]);let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('exit',code=>code?reject(Error(err)):resolve(JSON.parse(out.trim())));child.stdin.end(s);});
let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
run(['createdb',db]);
try{
  sql(readFileSync(new URL('../backend/schema.sql',import.meta.url),'utf8'));
  sql(readFileSync(new URL('../backend/updates.sql',import.meta.url),'utf8'));
  sql(readFileSync(new URL('../backend/updates-approval-settings.sql',import.meta.url),'utf8'));
  // A fake decrypted view tests our bridge permissions, not Vault encryption.
  sql("create schema vault; create table vault.decrypted_secrets(name text,decrypted_secret text); insert into vault.decrypted_secrets values('relay_update_publisher','{\"appId\":\"123\"}'),('unrelated','{\"private\":true}');");
  sql(readFileSync(new URL('../backend/updates-vault.sql',import.meta.url),'utf8'));
  const code=randomBytes(32).toString('hex'),password='Test!'+randomBytes(16).toString('hex');
  sql(`update relay_private.studio set setup_hash=${quote(createHash('sha256').update(code).digest('hex'))} where singleton;`);
  const manager=good(rpc('setup','',{name:'Test manager',username:'manager',password,setupCode:code,state:emptyState()}));
  const worker=good(rpc('workers.create',manager.token,{name:'Test worker',username:'worker',password,workRole:'Builder'}));
  const login=good(rpc('login','',{role:'worker',username:'worker',password,rateKey:'test'}));
  await check('anonymous and authenticated roles cannot call internal RPC or table',()=>{
    for(const role of ['anon','authenticated'])for(const stmt of ["select public.relay_updates_rpc('updates.load')","select * from relay_private.update_room"]){
      const r=spawnSync('runuser',['-u','postgres','--',...psql],{input:`set role ${role}; ${stmt};`,encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/permission denied/);
    }
  });
  await check('invalid sessions rejected and identity comes from real account',()=>{
    assert.equal(updates('updates.load','invalid').error.code,'SESSION');
    const s=good(updates('updates.load',login.token,{user:{role:'manager'}}));assert.equal(s.user.id,worker.id);assert.equal(s.user.role,'worker');assert.equal(s.revision,0);assert.deepEqual(s.proposals,[]);
  });
  await check('publisher bridge is restricted to service role and one named configuration',()=>{
    for(const role of ['anon','authenticated'])for(const stmt of ['select public.relay_update_publisher_credentials()','select relay_private.update_publisher_secret()','select * from vault.decrypted_secrets']){
      const r=spawnSync('runuser',['-u','postgres','--',...psql],{input:`set role ${role}; ${stmt};`,encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/permission denied/);
    }
    assert.deepEqual(JSON.parse(sql('set role service_role; select public.relay_update_publisher_credentials();')),{appId:'123'});
    const r=spawnSync('runuser',['-u','postgres','--',...psql],{input:'set role service_role; select * from vault.decrypted_secrets;',encoding:'utf8'});assert.notEqual(r.status,0);
  });
  await check('concurrent commits allow one exact revision',async()=>{
    const query=tag=>`set role service_role; select public.relay_updates_rpc('updates.commit',${quote(login.token)},${quote(JSON.stringify({expectedRevision:0,proposals:[{id:tag}]}))}::jsonb);`;
    const r=await Promise.all([concurrent(query('a')),concurrent(query('b'))]);assert.equal(r.filter(x=>!x.error).length,1);assert.equal(r.find(x=>x.error).error.code,'CONFLICT');
  });
  await check('stale and malformed writes cannot overwrite stored data',()=>{
    assert.equal(updates('updates.commit',login.token,{expectedRevision:0,proposals:[]}).error.code,'CONFLICT');
    assert.equal(updates('updates.commit',login.token,{expectedRevision:1,proposals:{}}).error.code,'CAPACITY');
    assert.equal(good(updates('updates.load',manager.token)).proposals.length,1);
  });
  await check('approval settings are manager-only, persist across worker commits, and guard account races',()=>{
    let state=good(updates('updates.load',manager.token));
    assert.deepEqual(state.policy,{mode:'one',allowSelfApproval:false});
    const policy={mode:'agents',allowSelfApproval:true};
    const payload={expectedRevision:state.revision,expectedContextRevision:state.contextRevision,proposals:state.proposals,policy};
    assert.equal(updates('updates.commit',login.token,payload).error.code,'FORBIDDEN');
    state=good(updates('updates.commit',manager.token,payload));assert.deepEqual(state.policy,policy);
    state=good(updates('updates.commit',login.token,{expectedRevision:state.revision,proposals:state.proposals}));assert.deepEqual(state.policy,policy);
    const before=state.contextRevision;
    good(rpc('workers.update',manager.token,{workerId:worker.id,name:'Test worker',workRole:'Builder',enabled:true}));
    assert.equal(updates('updates.commit',manager.token,{expectedRevision:state.revision,expectedContextRevision:before,proposals:state.proposals}).error.code,'CONFLICT');
  });
  await check('disabled worker session immediately loses update access',()=>{
    good(rpc('workers.update',manager.token,{workerId:worker.id,name:'Test worker',workRole:'Builder',enabled:false}));
    assert.equal(updates('updates.load',login.token).error.code,'SESSION');
  });
  await check('studio deletion clears update code and denies further access',()=>{
    good(rpc('workspace.delete',manager.token,{currentPassword:password,confirmation:'DELETE MY STUDIO'}));
    assert.equal(sql('select count(*) from relay_private.update_room;'),'0');assert.ok(updates('updates.load',manager.token).error);
    assert.equal(sql('set role service_role; select public.relay_update_publisher_credentials() is null;'),'t');
  });
  console.log(`${passed} local SQL integration groups passed.`);
}finally{run(['dropdb',db]);}
