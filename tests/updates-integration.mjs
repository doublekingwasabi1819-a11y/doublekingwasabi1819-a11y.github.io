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
  await check('concurrent commits allow one exact revision',async()=>{
    const query=tag=>`set role service_role; select public.relay_updates_rpc('updates.commit',${quote(login.token)},${quote(JSON.stringify({expectedRevision:0,proposals:[{id:tag}]}))}::jsonb);`;
    const r=await Promise.all([concurrent(query('a')),concurrent(query('b'))]);assert.equal(r.filter(x=>!x.error).length,1);assert.equal(r.find(x=>x.error).error.code,'CONFLICT');
  });
  await check('stale and malformed writes cannot overwrite stored data',()=>{
    assert.equal(updates('updates.commit',login.token,{expectedRevision:0,proposals:[]}).error.code,'CONFLICT');
    assert.equal(updates('updates.commit',login.token,{expectedRevision:1,proposals:{}}).error.code,'CAPACITY');
    assert.equal(good(updates('updates.load',manager.token)).proposals.length,1);
  });
  await check('disabled worker session immediately loses update access',()=>{
    good(rpc('workers.update',manager.token,{workerId:worker.id,name:'Test worker',workRole:'Builder',enabled:false}));
    assert.equal(updates('updates.load',login.token).error.code,'SESSION');
  });
  await check('studio deletion clears update code and denies further access',()=>{
    good(rpc('workspace.delete',manager.token,{currentPassword:password,confirmation:'DELETE MY STUDIO'}));
    assert.equal(sql('select count(*) from relay_private.update_room;'),'0');assert.ok(updates('updates.load',manager.token).error);
  });
  console.log(`${passed} local SQL integration groups passed.`);
}finally{run(['dropdb',db]);}
