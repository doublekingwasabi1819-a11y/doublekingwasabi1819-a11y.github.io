import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdatesHandler,createUpdatesRPC} from '../backend/updates-handler.mjs';
import {createGitHubPublisher,REPOSITORY} from '../backend/updates-github.mjs';
import {createProposal,combineProposals,reviewProposal} from '../updates-policy.mjs';

const BASE='a'.repeat(40),HEAD='b'.repeat(40),OTHER='c'.repeat(40);
const AT=Date.parse('2026-10-02T23:00:00Z');
const ORIGIN='https://doublekingwasabi1819-a11y.github.io';
const users={atlas:{id:'atlas',name:'Atlas',role:'worker'},bob:{id:'bob',name:'Bob',role:'worker'},steve:{id:'steve',name:'Steve',role:'worker'},manager:{id:'manager',name:'Owner',role:'manager'}};
const error=(code,message='Synthetic test error',status=409)=>Object.assign(new Error(message),{code,status});
const bundle=extra=>({id:crypto.randomUUID(),title:'Inbox update',description:'Keep the composer visible.',base:BASE,files:[{path:'inbox.css',content:'.inbox { display:grid; }'}],...extra});
const fixtureSources=new Map();
async function proposal({approved=true,staged=true,...extra}={}){
  const source=await createProposal(bundle(),users.atlas,new Date(AT).toISOString());
  let p=await combineProposals({id:crypto.randomUUID(),base:BASE,selected:[{id:source.id,digest:source.digest}]},[source],users.atlas,new Date(AT).toISOString());
  fixtureSources.set(p.id,source);
  if(approved)for(const user of [users.bob,users.steve])p=reviewProposal(p,{digest:p.digest,decision:'approve',body:'Reviewed the files.'},user,new Date(AT).toISOString());
  if(staged)Object.assign(p,{status:'staged',github:{head:HEAD,branch:'relay-update/'+p.id,pr:1,url:'https://github.com/'+REPOSITORY+'/pull/1'},checks:{state:'success',head:HEAD,base:BASE}});
  return {...p,...extra};
}

// A compare-and-swap contract fixture. Real SQL ACLs require a database test.
function database(proposals=[],{loseFirstAcknowledgement=false,policy={mode:'agents',allowSelfApproval:false}}={}){
  const sources=proposals.flatMap(p=>fixtureSources.has(p.id)&&!proposals.some(x=>x.id===fixtureSources.get(p.id).id)?[fixtureSources.get(p.id)]:[]);
  let records=structuredClone([...proposals,...sources]),revision=0,writes=0;
  const calls=[];
  const rpc=async(action,token,data={})=>{
    calls.push({action,token,data:structuredClone(data)});
    if(!users[token])throw error('SESSION','Session invalid',401);
    if(action==='updates.commit'){
      if(data.expectedRevision!==revision)throw error('CONFLICT');
      records=structuredClone(data.proposals);if(data.policy)policy=structuredClone(data.policy);revision++;writes++;
      if(loseFirstAcknowledgement&&writes===1)throw error('NETWORK','Saved, but response lost',503);
    }else assert.equal(action,'updates.load');
    return {user:structuredClone(users[token]),proposals:structuredClone(records),revision,policy:structuredClone(policy),activeAccounts:Object.values(users),activeAccountIds:Object.keys(users)};
  };
  return {rpc,calls,read:()=>structuredClone(records),writes:()=>writes};
}
function publisher(overrides={}){
  const calls=[];
  return {
    calls,
    repository:async()=>({name:REPOSITORY,main:BASE,connected:true}),
    stage:async p=>{calls.push(['stage',p.id]);return {head:HEAD,branch:'relay-update/'+p.id,pr:1,url:'https://github.com/'+REPOSITORY+'/pull/1'};},
    check:async p=>({state:'success',head:p.github?.head,base:p.base,summary:'Passed'}),
    publish:async p=>{calls.push(['publish',p.id]);return {sha:p.github.head};},
    deployment:async()=>({state:'success',summary:'The website is live.'}),
    outcome:async(p,main)=>main===p.github.head?'applied':'not-applied',
    ...overrides,
  };
}
const handler=(db,pub,now=()=>AT)=>createUpdatesHandler({rpc:db.rpc,publisher:pub,now});
async function call(handle,action,data={},token='atlas',headers={}){
  const response=await handle(new Request('https://relay.example/updates',{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN,...(token?{Authorization:'Bearer '+token}:{}),...headers},body:JSON.stringify({action,data})}));
  return {status:response.status,headers:response.headers,body:await response.json()};
}

test('service requires a live session, an exact origin, and never exposes internal commit actions',async()=>{
  const db=database(),pub=publisher(),handle=handler(db,pub);
  assert.equal((await call(handle,'updates.list',{},'')).status,401);
  assert.equal((await call(handle,'updates.list',{},'expired')).status,401);
  assert.equal((await call(handle,'updates.list',{},'atlas',{Origin:ORIGIN+'.attacker.example'})).status,403);
  for(const token of ['atlas','manager'])for(const action of ['updates.load','updates.commit']){
    const response=await call(handle,action,{expectedRevision:0,proposals:[]},token);
    assert.equal(response.status,400);
  }
  assert.equal(db.writes(),0);assert.equal(pub.calls.length,0);
  const response=await call(handle,'updates.list');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),ORIGIN);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
});

test('workers cannot publish or forge proposal identity, status, checks or reviews',async()=>{
  const p=await proposal(),db=database([p]),pub=publisher(),handle=handler(db,pub);
  const blocked=await call(handle,'updates.publish',{id:p.id,digest:p.digest,role:'manager',owner:true,user:users.manager});
  assert.equal(blocked.status,403);assert.equal(blocked.body.error.code,'FORBIDDEN');
  const forged=bundle({authorId:'manager',authorName:'Owner',authorIds:[],status:'published',version:91,github:{head:HEAD},checks:{state:'success'},reviews:p.reviews,role:'manager'});
  const submitted=await call(handle,'updates.submit',forged);
  assert.equal(submitted.status,200);
  const created=db.read().find(item=>item.id===forged.id);
  assert.equal(created.authorId,'atlas');assert.equal(created.authorName,'Atlas');assert.deepEqual(created.authorIds,['atlas']);assert.equal(created.status,'draft');assert.equal(created.version,1);assert.deepEqual(created.reviews,[]);assert.equal(created.github,undefined);assert.equal(created.checks,undefined);
  assert.equal(pub.calls.filter(([kind])=>kind==='publish').length,0);
});

test('author cannot review and two distinct exact-version approvals are required at publish',async()=>{
  const p=await proposal({approved:false}),db=database([p]),pub=publisher(),handle=handler(db,pub);
  assert.equal((await call(handle,'updates.review',{id:p.id,digest:p.digest,decision:'approve'})).status,403);
  assert.equal((await call(handle,'updates.review',{id:p.id,digest:'0'.repeat(64),decision:'approve'},'bob')).status,409);
  for(const token of ['bob','bob'])assert.equal((await call(handle,'updates.review',{id:p.id,digest:p.digest,decision:'approve',reviewerId:'steve'},token)).status,200);
  assert.equal((await call(handle,'updates.publish',{id:p.id,digest:p.digest},'manager')).status,409);
  assert.equal(pub.calls.filter(([kind])=>kind==='publish').length,0);
  assert.equal((await call(handle,'updates.review',{id:p.id,digest:p.digest,decision:'approve'},'steve')).status,200);
  assert.equal((await call(handle,'updates.publish',{id:p.id,digest:p.digest},'manager')).status,200);
  assert.equal(pub.calls.filter(([kind])=>kind==='publish').length,1);
});

test('publish refreshes checks instead of trusting cached success or client-supplied results',async()=>{
  for(const checks of [{state:'pending'},{state:'failure'},{state:'success',head:OTHER},{state:'success',base:OTHER}]){
    const p=await proposal(),db=database([p]),pub=publisher({check:async()=>({head:HEAD,base:BASE,...checks})});
    const response=await call(handler(db,pub),'updates.publish',{id:p.id,digest:p.digest,checks:{state:'success',head:HEAD,base:BASE}},'manager');
    assert.equal(response.status,409,JSON.stringify(checks));assert.equal(pub.calls.length,0);assert.equal(db.read()[0].status,'staged');
  }
});

test('revision during a slow provider check cannot publish an already reviewed version',async()=>{
  const p=await proposal(),db=database([p]);let entered,release;
  const waiting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const pub=publisher({check:async()=>{entered();await gate;return {state:'success',head:HEAD,base:BASE};}}),handle=handler(db,pub);
  const publishing=call(handle,'updates.publish',{id:p.id,digest:p.digest},'manager');await waiting;
  const source=fixtureSources.get(p.id);
  const revised=await call(handle,'updates.submit',bundle({id:source.id,expectedVersion:1,expectedDigest:source.digest,title:'Changed after review'}));
  assert.equal(revised.status,200);release();
  assert.equal((await publishing).status,409);assert.equal(pub.calls.filter(([kind])=>kind==='publish').length,0);const current=db.read().find(x=>x.id===p.id);assert.equal(current.version,2);assert.deepEqual(current.reviews,[]);
});

test('submission retry after a lost acknowledgement creates exactly one proposal and preserves reviews',async()=>{
  const data=bundle(),db=database([],{loseFirstAcknowledgement:true}),pub=publisher(),handle=handler(db,pub);
  assert.equal((await call(handle,'updates.submit',data)).status,503);
  const first=db.read()[0];assert.equal(first.id,data.id);
  assert.equal((await call(handle,'updates.review',{id:first.id,digest:first.digest,decision:'approve'},'bob')).status,200);
  const retry=await call(handle,'updates.submit',data);
  assert.equal(retry.status,200);const sources=db.read().filter(x=>x.kind!=='release');assert.equal(sources.length,1);assert.equal(sources[0].id,data.id);assert.equal(sources[0].version,1);assert.equal(sources[0].reviews.length,1);
});

test('two concurrent publish requests acquire only one global publication lock',async()=>{
  const first=await proposal(),db=database([first]),pub=publisher();
  const handle=handler(db,pub),responses=await Promise.all([first,first].map(p=>call(handle,'updates.publish',{id:p.id,digest:p.digest},'manager')));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(pub.calls.filter(([kind])=>kind==='publish').length,1);assert.equal(db.read().filter(p=>p.status==='publishing').length,1);
});

test('ambiguous network response remains locked, then exact-head deployment reconciliation completes it',async()=>{
  let main=BASE;const p=await proposal(),db=database([p]);
  const pub=publisher({repository:async()=>({main,connected:true}),publish:async()=>{main=HEAD;throw error('NETWORK','Response was lost',503);}}),handle=handler(db,pub);
  assert.equal((await call(handle,'updates.publish',{id:p.id,digest:p.digest},'manager')).status,503);
  assert.equal(db.read()[0].status,'publishing');assert.match(db.read()[0].publishError,/Refresh/);
  const refresh=await call(handle,'updates.refresh',{id:p.id});
  assert.equal(refresh.status,200);assert.equal(db.read()[0].status,'published');assert.equal(db.read()[0].deployment.state,'success');
});

test('an uncommitted unknown publication recovers only after the uncertainty window',async()=>{
  let clock=AT;const p=await proposal(),db=database([p]);
  const pub=publisher({publish:async()=>{throw error('NETWORK','Response was lost',503);}}),handle=handler(db,pub,()=>clock);
  await call(handle,'updates.publish',{id:p.id,digest:p.digest},'manager');
  await call(handle,'updates.refresh',{id:p.id});assert.equal(db.read()[0].status,'publishing');
  clock+=120001;await call(handle,'updates.refresh',{id:p.id});assert.equal(db.read()[0].status,'staged');
});

test('a definite main-branch conflict cannot leave the global publication lock stuck forever',async()=>{
  let main=BASE,clock=AT;const p=await proposal(),db=database([p]);
  const pub=publisher({repository:async()=>({main,connected:true}),publish:async()=>{main=OTHER;throw error('CONFLICT','Main changed');}}),handle=handler(db,pub,()=>clock);
  assert.equal((await call(handle,'updates.publish',{id:p.id,digest:p.digest},'manager')).status,409);
  clock+=120001;await call(handle,'updates.refresh',{id:p.id});
  assert.notEqual(db.read()[0].status,'publishing');
});

test('terminal Pages failure or a superseding main update releases the lock and exposes its outcome',async()=>{
  for(const state of ['failure','superseded']){
    const p=await proposal({status:'publishing',publishStartedAt:new Date(AT).toISOString()}),db=database([p]);
    const pub=publisher({outcome:async()=>state==='superseded'?'superseded':'applied',deployment:async()=>({state,summary:'Publication did not become the current live version.'})});
    const result=await call(handler(db,pub),'updates.refresh',{id:p.id});
    assert.equal(result.status,200);assert.equal(db.read()[0].status,'published');assert.equal(db.read()[0].deployment.state,state);
    const visible=result.body.proposals[0];
    assert.equal(visible.deployment.state,state);assert.equal(visible.readiness.ready,false);
    if(state==='failure')assert.equal(visible.readiness.color,'red');
    else assert.match(visible.deployment.summary,/newer version/);
  }
});

test('RPC credentials are confined to the configured server request and provider failures are sanitized',async()=>{
  const calls=[],rpc=createUpdatesRPC({url:'https://database.example/',serviceKey:'synthetic-server-key',fetcher:async(url,options)=>{calls.push({url,options});return Response.json({user:users.atlas,revision:0,proposals:[],activeAccountIds:[]});}});
  const response=await call(createUpdatesHandler({rpc,publisher:publisher()}),'updates.list');
  assert.equal(response.status,200);assert.ok(calls.length>0);
  for(const {url,options} of calls){assert.equal(url,'https://database.example/rest/v1/rpc/relay_updates_rpc');assert.equal(options.headers.apikey,'synthetic-server-key');assert.equal(options.headers.Authorization,'Bearer synthetic-server-key');assert.equal(JSON.parse(options.body).p_token,'atlas');}
  assert.ok(!JSON.stringify(response.body).includes('synthetic-server-key'));
  const failed=createUpdatesRPC({url:'https://database.example',serviceKey:'synthetic-server-key',fetcher:async()=>{throw new Error('synthetic-server-key in an upstream diagnostic');}});
  const denied=await call(createUpdatesHandler({rpc:failed,publisher:publisher()}),'updates.list');assert.equal(denied.status,503);assert.ok(!JSON.stringify(denied.body).includes('synthetic-server-key'));
});

let keyPromise;
async function privateKey(){
  keyPromise??=(async()=>{
    const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
    return '-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----';
  })();return keyPromise;
}
async function github(provider){
  const calls=[],key=await privateKey();
  const fetcher=async(url,options={})=>{
    calls.push({url,options});
    if(url==='https://api.github.com/app/installations/7/access_tokens')return Response.json({token:'synthetic-installation-token',expires_at:new Date(AT+3600000).toISOString()});
    assert.ok(url.startsWith('https://api.github.com/repos/'+REPOSITORY));
    assert.equal(options.headers.Authorization,'Bearer synthetic-installation-token');assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
    return provider(url.split(REPOSITORY)[1],options);
  };
  return {calls,publisher:createGitHubPublisher({appId:'8',installationId:'7',privateKey:key,fetcher,now:()=>AT})};
}

test('GitHub publication checks main and uses an atomic non-force fast-forward for the final race',async()=>{
  const p=await proposal();let main=BASE;
  const fixture=await github(async(path,options)=>{
    if(path==='/git/ref/heads/main')return Response.json({object:{sha:main}});
    assert.equal(path,'/git/refs/heads/main');assert.equal(options.method,'PATCH');assert.deepEqual(JSON.parse(options.body),{sha:HEAD,force:false});
    main=OTHER;return Response.json({message:'Not a fast forward'},{status:422});
  });
  await assert.rejects(()=>fixture.publisher.publish(p),e=>e.code==='CONFLICT');
  assert.equal(main,OTHER);assert.equal(fixture.calls.filter(c=>c.options.method==='PATCH').length,1);
  await assert.rejects(()=>fixture.publisher.publish(p),e=>e.code==='CONFLICT');
  assert.equal(fixture.calls.filter(c=>c.options.method==='PATCH').length,1);
});

test('GitHub checks accept only the newest trusted workflow run on the exact branch and head',async()=>{
  const p=await proposal();let runs=[];
  const run=(id,extra={})=>({id,head_sha:HEAD,head_branch:p.github.branch,path:'.github/workflows/relay-update-checks.yml',event:'pull_request',status:'completed',conclusion:'success',html_url:'https://github.com/'+REPOSITORY+'/actions/runs/'+id,...extra});
  const fixture=await github(async path=>{
    if(path==='/git/ref/heads/main')return Response.json({object:{sha:BASE}});
    if(path==='/git/ref/heads/'+p.github.branch)return Response.json({object:{sha:HEAD}});
    if(path==='/git/commits/'+HEAD)return Response.json({parents:[{sha:BASE}]});
    assert.equal(path,'/actions/workflows/relay-update-checks.yml/runs?head_sha='+HEAD+'&event=pull_request&per_page=20');return Response.json({workflow_runs:runs});
  });
  runs=[run(100,{head_sha:OTHER}),run(101,{head_branch:'another-branch'}),run(102,{path:'.github/workflows/untrusted.yml'})];
  assert.equal((await fixture.publisher.check(p)).state,'pending');
  runs.push(run(99));assert.equal((await fixture.publisher.check(p)).state,'success');
  runs.push(run(103,{status:'in_progress',conclusion:null}));assert.equal((await fixture.publisher.check(p)).state,'pending');
  runs.push(run(104,{conclusion:'failure'}));assert.equal((await fixture.publisher.check(p)).state,'failure');
});

test('GitHub checks reject rewritten branch, wrong parent and stale main before considering CI',async()=>{
  const p=await proposal();
  for(const scenario of [{ref:OTHER,parent:BASE,main:BASE},{ref:HEAD,parent:OTHER,main:BASE},{ref:HEAD,parent:BASE,main:OTHER}]){
    const fixture=await github(async path=>{
      if(path==='/git/ref/heads/main')return Response.json({object:{sha:scenario.main}});
      if(path==='/git/ref/heads/'+p.github.branch)return Response.json({object:{sha:scenario.ref}});
      if(path==='/git/commits/'+HEAD)return Response.json({parents:[{sha:scenario.parent}]});
      assert.fail('Invalid staged commit must not reach workflow lookup: '+path);
    });
    assert.equal((await fixture.publisher.check(p)).state,'failure');
  }
});

test('GitHub reconciliation distinguishes applied, superseded, and divergent heads using ancestry',async()=>{
  const p=await proposal();let comparison='ahead';
  const fixture=await github(async path=>{assert.equal(path,'/compare/'+HEAD+'...'+OTHER);return Response.json({status:comparison});});
  assert.equal(await fixture.publisher.outcome(p,HEAD),'applied');assert.equal(await fixture.publisher.outcome(p,BASE),'not-applied');
  assert.equal(fixture.calls.length,0);
  assert.equal(await fixture.publisher.outcome(p,OTHER),'superseded');comparison='diverged';assert.equal(await fixture.publisher.outcome(p,OTHER),'not-applied');
});

test('GitHub installation token is restricted to this repository and is never returned to clients',async()=>{
  const fixture=await github(async path=>{assert.equal(path,'/git/ref/heads/main');return Response.json({object:{sha:BASE}});});
  const result=await fixture.publisher.repository(),auth=fixture.calls.find(c=>c.url.endsWith('/access_tokens'));
  assert.deepEqual(JSON.parse(auth.options.body),{repositories:[REPOSITORY.split('/')[1]],permissions:{contents:'write',pull_requests:'write',actions:'read',checks:'read'}});
  assert.equal(auth.options.redirect,'error');assert.ok(auth.options.signal instanceof AbortSignal);
  assert.deepEqual(result,{name:REPOSITORY,main:BASE,connected:true});
  assert.ok(!JSON.stringify(result).includes('synthetic-installation-token'));
});


test('only manager changes policy; one sign-off, manager-only and self-sign-off are enforced',async()=>{
  const p=await proposal({approved:false}),db=database([p],{policy:{mode:'one',allowSelfApproval:false}}),pub=publisher(),h=handler(db,pub);
  assert.equal((await call(h,'updates.settings',{policy:{mode:'one',allowSelfApproval:true}})).status,403);
  assert.equal((await call(h,'updates.settings',{},'manager')).status,400);
  assert.equal((await call(h,'updates.review',{id:p.id,digest:p.digest,decision:'approve'},'bob')).status,200);
  assert.equal((await call(h,'updates.list')).body.proposals[0].readiness.ready,true);
  assert.equal((await call(h,'updates.settings',{policy:{mode:'manager',allowSelfApproval:false}},'manager')).status,200);
  assert.equal((await call(h,'updates.list')).body.proposals[0].readiness.ready,false);
  assert.equal((await call(h,'updates.review',{id:p.id,digest:p.digest,decision:'approve'},'steve')).status,403);
  assert.equal((await call(h,'updates.review',{id:p.id,digest:p.digest,decision:'approve'},'manager')).status,200);
  assert.equal((await call(h,'updates.list')).body.proposals[0].readiness.ready,true);
  assert.equal((await call(h,'updates.settings',{policy:{mode:'agents',allowSelfApproval:true}},'manager')).status,200);
  assert.equal((await call(h,'updates.review',{id:p.id,digest:p.digest,decision:'approve'},'atlas')).status,200);
  assert.equal((await call(h,'updates.list')).body.proposals[0].readiness.approvalCount,2);
});

test('explicit manager override publishes without reviews, is audited, and workers cannot invoke it',async()=>{
  const p=await proposal({approved:false}),db=database([p]),pub=publisher(),h=handler(db,pub);
  assert.equal((await call(h,'updates.publish',{id:p.id,digest:p.digest,managerOverride:true})).status,403);
  assert.equal((await call(h,'updates.publish',{id:p.id,digest:p.digest,managerOverride:true},'manager')).status,200);
  assert.equal(db.read()[0].managerOverride,true);assert.equal(db.read()[0].publishedBy,'manager');
  const q=await proposal({approved:false}),db2=database([q]),h2=handler(db2,publisher({check:async()=>({state:'failure',head:HEAD,base:BASE})}));
  assert.equal((await call(h2,'updates.publish',{id:q.id,digest:q.digest,managerOverride:true},'manager')).status,409);
  assert.equal(db2.writes(),0);
});

test('disabling the sole reviewer between load and commit forces a fresh eligibility check',async()=>{
  let p=await proposal({approved:false});p=reviewProposal(p,{digest:p.digest,decision:'approve'},users.bob,new Date(AT).toISOString());
  const db=database([p],{policy:{mode:'one',allowSelfApproval:false}}),pub=publisher();let contextRevision=1,disabled=false;
  const rpc=async(action,token,data)=>{
    if(action==='updates.commit'){
      if(!disabled){disabled=true;contextRevision++;}
      if(data.expectedContextRevision!==contextRevision)throw error('CONFLICT');
    }
    const state=await db.rpc(action,token,data);
    return {...state,contextRevision,activeAccounts:Object.values(users).filter(u=>!disabled||u.id!=='bob'),activeAccountIds:Object.keys(users).filter(id=>!disabled||id!=='bob')};
  };
  const h=createUpdatesHandler({rpc,publisher:pub,now:()=>AT});
  const r=await call(h,'updates.publish',{id:p.id,digest:p.digest},'manager');
  assert.equal(r.status,409);assert.equal(r.body.error.code,'NOT_READY');assert.equal(db.writes(),0);assert.equal(pub.calls.length,0);
});

test('settings freeze during publication and an updated policy is rechecked before publish',async()=>{
  const p=await proposal({approved:false}),db=database([p]),pub=publisher(),h=handler(db,pub);
  pub.check=async q=>{await call(h,'updates.settings',{policy:{mode:'manager',allowSelfApproval:false}},'manager');return {state:'success',head:q.github.head,base:q.base};};
  assert.equal((await call(h,'updates.publish',{id:p.id,digest:p.digest},'manager')).body.error.code,'NOT_READY');
  const locked=database([{...p,status:'publishing'}]);
  assert.equal((await call(handler(locked,publisher()),'updates.settings',{policy:{mode:'one',allowSelfApproval:true}},'manager')).status,409);
  assert.equal(locked.writes(),0);
});

test('every submitted change automatically feeds one shared update and retries preserve its reviews',async()=>{
  const db=database([],{policy:{mode:'one',allowSelfApproval:false}}),pub=publisher(),h=handler(db,pub);
  const a=bundle({files:[{path:'a.css',content:'.a{}'}]});
  let r=await call(h,'updates.submit',a);assert.equal(r.status,200);
  const first=r.body.proposals.find(p=>p.kind==='release');assert.equal(first.sources.length,1);assert.equal(first.status,'staged');assert.equal(pub.calls.length,1);
  await call(h,'updates.review',{id:first.id,digest:first.digest,decision:'approve'},'steve');
  r=await call(h,'updates.prepare',{},'bob');const retry=r.body.proposals.find(p=>p.kind==='release');
  assert.equal(retry.digest,first.digest);assert.equal(retry.version,1);assert.equal(retry.reviews.length,1);assert.equal(pub.calls.length,1);
  const b=bundle({files:[{path:'b.css',content:'.b{}'}]});r=await call(h,'updates.submit',b,'bob');
  const next=r.body.proposals.find(p=>p.kind==='release');
  assert.equal(next.id,first.id);assert.equal(next.version,2);assert.equal(next.sources.length,2);assert.deepEqual(next.files.map(f=>f.path),['a.css','b.css']);assert.deepEqual(next.reviews,[]);assert.equal(next.checks.state,'pending');
  assert.equal(db.read().filter(p=>p.kind==='release').length,1);assert.equal(pub.calls.filter(([kind])=>kind==='publish').length,0);
});

test('overlapping edits stay on the bulletin board and become red until the conflict is corrected',async()=>{
  const db=database(),pub=publisher(),h=handler(db,pub),a=bundle(),b=bundle({files:[{path:'inbox.css',content:'.different{}'}]});
  await call(h,'updates.submit',a);
  let r=await call(h,'updates.submit',b,'bob');assert.equal(r.status,200);assert.equal(r.body.preparationError.code,'FILE_CONFLICT');assert.equal(r.body.assembly.state,'failure');
  assert.equal(db.read().filter(p=>p.kind!=='release').length,2);assert.equal(pub.calls.length,1);
  const current=r.body.proposals.find(p=>p.id===b.id);
  r=await call(h,'updates.submit',{...b,files:a.files,expectedVersion:current.version,expectedDigest:current.digest},'bob');
  assert.equal(r.status,200);assert.equal(r.body.preparationError,undefined);const release=r.body.proposals.find(p=>p.kind==='release');assert.equal(release.sources.length,2);assert.equal(release.files.length,1);
  r=await call(h,'updates.refresh',{id:release.id});assert.equal(r.body.assembly.state,'success');assert.equal(r.body.proposals.find(p=>p.id===release.id).readiness.ready,false);
});

test('shared preparation cannot choose a subset, and an individual contribution cannot be published',async()=>{
  const db=database(),pub=publisher(),h=handler(db,pub),a=bundle();await call(h,'updates.submit',a);
  assert.equal((await call(h,'updates.prepare',{selected:[{id:a.id}]},'manager')).status,400);
  const source=db.read().find(p=>p.id===a.id);
  const denied=await call(h,'updates.publish',{id:source.id,digest:source.digest,managerOverride:true},'manager');
  assert.equal(denied.status,409);assert.equal(denied.body.error.code,'SHARED_UPDATE_REQUIRED');assert.equal(pub.calls.filter(([kind])=>kind==='publish').length,0);
});

test('a new post during the final check prevents the old shared update from publishing even with override',async()=>{
  const db=database(),pub=publisher(),h=handler(db,pub);
  let r=await call(h,'updates.submit',bundle({files:[{path:'a.css',content:'.a{}'}]}));const p=r.body.proposals.find(p=>p.kind==='release');
  let entered,done;const checking=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>done=resolve);
  pub.check=async q=>{entered();await gate;return {state:'success',head:q.github.head,base:q.base};};
  const publishing=call(h,'updates.publish',{id:p.id,digest:p.digest,managerOverride:true},'manager');await checking;
  assert.equal((await call(h,'updates.submit',bundle({files:[{path:'b.css',content:'.b{}'}]}),'bob')).status,200);done();
  assert.equal((await publishing).status,409);assert.equal(pub.calls.filter(([kind])=>kind==='publish').length,0);
});

test('included sources are frozen during publish and all share the resulting commit and deployment',async()=>{
  let main=BASE,entered,done;const publishingStarted=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>done=resolve);
  const db=database(),pub=publisher({repository:async()=>({main,connected:true}),publish:async p=>{entered();await gate;main=p.github.head;return {sha:main};}}),h=handler(db,pub);
  const a=bundle({files:[{path:'a.css',content:'.a{}'}]}),b=bundle({files:[{path:'b.css',content:'.b{}'}]});
  await call(h,'updates.submit',a);let r=await call(h,'updates.submit',b,'bob');const release=r.body.proposals.find(p=>p.kind==='release'),source=r.body.proposals.find(p=>p.id===a.id);
  const pushing=call(h,'updates.publish',{id:release.id,digest:release.digest,managerOverride:true},'manager');await publishingStarted;
  assert.equal((await call(h,'updates.submit',{...a,title:'Changed during publish',expectedVersion:source.version,expectedDigest:source.digest})).status,409);
  assert.equal((await call(h,'updates.withdraw',{id:source.id,digest:source.digest})).status,409);
  done();assert.equal((await pushing).status,200);
  for(const p of db.read().filter(p=>p.kind!=='release')){assert.equal(p.status,'published');assert.equal(p.releaseId,release.id);assert.equal(p.publishedCommit,HEAD);assert.equal(p.publishedBy,'manager');assert.equal(p.managerOverride,true);assert.equal(p.deployment.state,'pending');}
  r=await call(h,'updates.refresh',{id:a.id});assert.equal(r.status,200);
  for(const p of db.read())assert.equal(p.deployment.state,'success');
  assert.equal(r.body.assembly.state,'empty');
});

test('lost publication acknowledgement reconciles the whole update and propagates Pages failure',async()=>{
  let main=BASE;const db=database(),pub=publisher({repository:async()=>({main,connected:true}),publish:async p=>{main=p.github.head;throw error('NETWORK','Lost response',503);},deployment:async()=>({state:'failure',summary:'Pages failed.'})}),h=handler(db,pub);
  const a=bundle({files:[{path:'a.css',content:'.a{}'}]}),b=bundle({files:[{path:'b.css',content:'.b{}'}]});await call(h,'updates.submit',a);const r=await call(h,'updates.submit',b,'bob'),release=r.body.proposals.find(p=>p.kind==='release');
  assert.equal((await call(h,'updates.publish',{id:release.id,digest:release.digest,managerOverride:true},'manager')).status,503);
  assert.equal(db.read().find(p=>p.id===a.id).status,'draft');
  const recovered=await call(h,'updates.refresh',{id:a.id});assert.equal(recovered.status,200);assert.equal(recovered.body.assembly.state,'failure');
  for(const p of db.read()){assert.equal(p.status,'published');assert.equal(p.deployment.state,'failure');}
  assert.equal(db.read().find(p=>p.id===a.id).releaseId,release.id);
});

test('withdrawing the last pending change makes the shared update empty and yellow',async()=>{
  const db=database(),h=handler(db,publisher()),a=bundle();let r=await call(h,'updates.submit',a);const source=r.body.proposals.find(p=>p.id===a.id);
  r=await call(h,'updates.withdraw',{id:a.id,digest:source.digest});assert.equal(r.status,200);assert.equal(r.body.assembly.state,'empty');assert.equal(db.read().filter(p=>!['published','withdrawn'].includes(p.status)).length,0);
});
