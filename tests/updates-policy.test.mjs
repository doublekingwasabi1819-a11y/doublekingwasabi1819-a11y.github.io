import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBundle,createProposal,reviseProposal,combineProposals,reviewProposal,readiness,publicProposal,UpdatePolicyError,approvalPolicy,mayReview} from '../updates-policy.mjs';

const BASE='a'.repeat(40),HEAD='b'.repeat(40),OTHER='c'.repeat(40),AT='2026-10-02T23:00:00Z';
const author={id:'atlas',name:'Atlas',role:'worker'};
const bob={id:'bob',name:'Bob',role:'worker'};
const steve={id:'steve',name:'Steve',role:'worker'};
const manager={id:'manager',name:'Owner',role:'manager'};
const bundle=(extra={})=>({id:crypto.randomUUID(),title:'Improve the inbox',description:'Keep the send button in view.',base:BASE,files:[{path:'inbox.css',content:'.inbox { display: grid; }'}],...extra});
const proposal=()=>createProposal(bundle(),author,AT);
const approve=(old,user=bob)=>reviewProposal(old,{digest:old.digest,decision:'approve',body:'Checked the proposed files.'},user,AT);
const staged=old=>({...old,status:'staged',github:{branch:'updates/test',head:HEAD,pr:1,url:'https://github.com/owner/repo/pull/1'},checks:{state:'success',head:HEAD,base:BASE,summary:'Checks passed.'}});
const context=extra=>({connected:true,main:BASE,proposals:[],activeAccounts:[author,bob,steve,manager],policy:{mode:'agents',allowSelfApproval:false},...extra});
const throwsCode=(fn,code)=>assert.throws(fn,error=>error instanceof UpdatePolicyError&&error.code===code);
const rejectsCode=(fn,code)=>assert.rejects(fn,error=>error instanceof UpdatePolicyError&&error.code===code);

test('bundle digest is deterministic across file order and excludes generated proposal identity',async()=>{
  const data=bundle({files:[{path:'z.js',content:'last'}, {path:'a.css',content:'first'}]});
  const a=await createProposal(data,author,AT),b=await createProposal({...data,id:crypto.randomUUID(),files:[...data.files].reverse()},author,AT);
  assert.notEqual(a.id,b.id);assert.equal(a.digest,b.digest);assert.match(a.id,/^[a-f0-9-]{36}$/);assert.match(a.digest,/^[a-f0-9]{64}$/);
  assert.deepEqual(a.files.map(file=>file.path),['a.css','z.js']);assert.equal(data.files[0].path,'z.js');
  for(const change of [{base:OTHER},{title:'New title'},{description:'New reason'},{files:[{path:'a.css',content:'other'}]}])assert.notEqual((await createProposal({...data,...change},author,AT)).digest,a.digest);
});

test('client cannot assign author, status, version, approval or GitHub checks during creation',async()=>{
  const created=await createProposal(bundle({authorId:'manager',authorIds:[],status:'staged',version:99,digest:'fake',reviews:[{reviewerId:'bob'}],github:{head:HEAD},checks:{state:'success'}}),author,AT);
  assert.equal(created.authorId,'atlas');assert.deepEqual(created.authorIds,['atlas']);assert.equal(created.version,1);assert.equal(created.status,'draft');assert.deepEqual(created.reviews,[]);assert.equal(created.github,undefined);assert.equal(created.checks,undefined);
});

test('client UUID is required and preserved for retry deduplication',async()=>{
  const data=bundle();assert.equal((await createProposal(data,author,AT)).id,data.id);assert.equal((await createProposal(data,author,AT)).id,data.id);
  for(const id of [undefined,'injected','00000000-0000-0000-0000-000000000000'])await rejectsCode(()=>createProposal({...data,id},author,AT),'INVALID_ID');
});

test('only authenticated active worker and manager identities can create proposals',async()=>{
  for(const bad of [null,{...author,role:'guest'},{...author,enabled:false},{...author,disabled:true}])await rejectsCode(()=>createProposal(bundle(),bad,AT),'FORBIDDEN');
  assert.equal((await createProposal(bundle(),manager,AT)).authorId,'manager');
});

test('safe-path validation blocks traversal, absolute paths, encoded paths, backslashes and hidden files',()=>{
  for(const path of ['../index.html','assets/../index.html','/index.html','C:/index.html','assets\\index.html','assets/%2e%2e/index.html','a//index.html','.env','.github/workflows/check.js','.nojekyll','assets/.hidden.js','index.html\0.js'])throwsCode(()=>validateBundle(bundle({files:[{path,content:'x'}]})),'UNSAFE_PATH');
});

test('protected configuration, server, test and workflow files cannot be submitted',()=>{
  for(const path of ['backend/handler.mjs','Backend/index.js','tests/a.js','scripts/check.js','node_modules/pkg/index.js','updates-policy.mjs','config.mjs','README.md','AGENTS.md','package.json','package-lock.json','bridge.mjs','relay-cli.mjs','github.mjs','image.png','script.sh','data.sql','a.ts','LICENSE'])throwsCode(()=>validateBundle(bundle({files:[{path,content:'x'}]})),'PROTECTED_FILE');
  assert.equal(validateBundle(bundle({files:[{path:'assets/components/inbox.mjs',content:'export default 1;'}]})).files.length,1);
});

test('case collisions, duplicate paths, and file-directory collisions are rejected regardless of order',()=>{
  for(const paths of [['a.css','a.css'],['a.css','A.CSS'],['Assets/a.js','assets/b.js'],['data.json','data.json/file.js'],['data.json/file.js','data.json']])throwsCode(()=>validateBundle(bundle({files:paths.map(path=>({path,content:'x'}))})),'DUPLICATE_PATH');
});

test('file and bundle limits count UTF-8 bytes, not JavaScript character counts',()=>{
  assert.equal(validateBundle(bundle({files:[{path:'a.txt',content:'é'.repeat(100000)}]})).files.length,1);
  throwsCode(()=>validateBundle(bundle({files:[{path:'a.txt',content:'é'.repeat(100001)}]})),'FILE_LIMIT');
  throwsCode(()=>validateBundle(bundle({files:Array.from({length:4},(_,i)=>({path:`${i}.txt`,content:'a'.repeat(200000)}))})),'BUNDLE_LIMIT');
  throwsCode(()=>validateBundle(bundle({files:Array.from({length:41},(_,i)=>({path:`${i}.txt`,content:''}))})),'FILE_LIMIT');
  throwsCode(()=>validateBundle(bundle({files:[]})),'FILE_LIMIT');
});

test('text metadata, full base SHA, and file Unicode are validated',()=>{
  for(const extra of [{title:''},{title:'x'.repeat(181)},{description:'x'.repeat(8001)},{files:[{path:'a.js',content:42}]},{files:[{path:'a.js',content:'\uD800'}]}])throwsCode(()=>validateBundle(bundle(extra)),'INVALID_UPDATE');
  for(const base of ['main','a'.repeat(39),BASE+'0',null])throwsCode(()=>validateBundle(bundle({base})),'INVALID_BASE');
  assert.equal(validateBundle(bundle({base:BASE.toUpperCase(),title:'  Title  '})).title,'Title');
});

test('obvious private credentials are rejected while public configuration is allowed',()=>{
  const jwtPayload=btoa(JSON.stringify({role:'service_role'})).replace(/=+$/,'');
  for(const content of ['-----BEGIN PRIVATE KEY-----','-----BEGIN RSA PRIVATE KEY-----','ghp_'+'X'.repeat(36),'github_pat_'+'a'.repeat(45),'sb_secret_'+'a'.repeat(25),'eyJhbGciOiJIUzI1NiJ9.'+jwtPayload+'.signature'])throwsCode(()=>validateBundle(bundle({files:[{path:'a.js',content}]})),'SECRET_DETECTED');
  assert.ok(validateBundle(bundle({files:[{path:'a.js',content:'const key="sb_publishable_public-example";'}]})));
});

test('revision is version-checked, preserves all editors as authors, and invalidates all approvals and checks',async()=>{
  const original=staged(approve(await proposal()));
  const revised=await reviseProposal(original,{...bundle(),expectedVersion:1},manager,AT);
  assert.equal(revised.version,2);assert.equal(revised.authorId,'atlas');assert.deepEqual(revised.authorIds,['atlas','manager']);assert.notEqual(revised.digest,original.digest);assert.equal(revised.id,original.id);assert.equal(revised.status,'draft');assert.deepEqual(revised.reviews,[]);assert.equal(revised.github,undefined);assert.equal(revised.checks,undefined);
  assert.equal(original.version,1);assert.equal(original.reviews.length,1);
  const again=await reviseProposal(revised,{...bundle(),expectedVersion:2},author,AT);
  assert.deepEqual(again.authorIds,['atlas','manager']);assert.equal(approve(again,manager).reviews[0].reviewerId,'manager');
  await rejectsCode(()=>reviseProposal(revised,{...bundle(),expectedVersion:1},author,AT),'VERSION_CONFLICT');
  await rejectsCode(()=>reviseProposal(revised,{...bundle(),expectedVersion:2,expectedDigest:original.digest},author,AT),'VERSION_CONFLICT');
  await rejectsCode(()=>reviseProposal(revised,bundle(),author,AT),'VERSION_CONFLICT');
  await rejectsCode(()=>reviseProposal(original,{...bundle(),expectedVersion:1},steve,AT),'FORBIDDEN');
});

test('reviews require exact current digest and cannot be supplied by any author or editor',async()=>{
  const old=await proposal();
  throwsCode(()=>approve(old,author),'REVIEW_FORBIDDEN');
  for(const digest of [undefined,'0'.repeat(64),'not-a-digest'])throwsCode(()=>reviewProposal(old,{digest,decision:'approve'},bob,AT),'VERSION_CONFLICT');
  throwsCode(()=>reviewProposal(old,{digest:old.digest,decision:'unknown'},bob,AT),'INVALID_REVIEW');
  throwsCode(()=>reviewProposal(old,{digest:old.digest,decision:'changes',body:''},bob,AT),'INVALID_UPDATE');
  const approved=approve(old);assert.equal(old.reviews.length,0);assert.equal(approved.reviews[0].digest,old.digest);
});

test('one reviewer only counts once and can resolve their own change request',async()=>{
  const old=staged(await proposal());
  let current=approve(approve(old,bob),bob);assert.equal(current.reviews.length,1);assert.equal(readiness(current,context()).approvalCount,1);
  current=reviewProposal(current,{digest:current.digest,decision:'changes',body:'Keyboard focus needs fixing.'},bob,AT);
  current=approve(current,steve);assert.equal(readiness(current,context()).state,'blocked');
  current=approve(current,bob);assert.equal(current.reviews.length,2);assert.equal(readiness(current,context()).state,'ready');
});

test('readiness requires two distinct independent approvals and exact checks against the staged head and base',async()=>{
  const p=staged(approve(approve(await proposal(),bob),steve));
  assert.deepEqual({state:readiness(p,context()).state,ready:readiness(p,context()).ready,count:readiness(p,context()).approvalCount},{state:'ready',ready:true,count:2});
  const cases=[
    [p,context({connected:false}),'NOT_CONNECTED'],
    [p,context({main:OTHER}),'STALE_BASE'],
    [p,context({main:undefined}),'UNKNOWN_BASE'],
    [{...p,status:'draft'},context(),'NOT_STAGED'],
    [{...p,github:{...p.github,head:undefined}},context(),'MISSING_HEAD'],
    [{...p,checks:{...p.checks,state:'pending'}},context(),'CHECKS_PENDING'],
    [{...p,checks:{...p.checks,state:'failure'}},context(),'CHECKS_FAILED'],
    [{...p,checks:{...p.checks,head:OTHER}},context(),'STALE_CHECKS'],
    [{...p,checks:{...p.checks,base:OTHER}},context(),'STALE_CHECKS'],
    [{...p,reviews:p.reviews.slice(0,1)},context(),'REVIEWS_PENDING'],
    [p,context({proposals:[{id:'other',status:'publishing',files:[]}]}),'PUBLISH_LOCK']
  ];
  for(const [update,repo,code] of cases){const gate=readiness(update,repo);assert.equal(gate.ready,false,code);assert.ok(gate.blockers.some(reason=>reason.code===code),code);}
});

test('stale, authored, duplicate, and inactive-account reviews cannot satisfy readiness',async()=>{
  const p=staged(await proposal());
  const valid={reviewerId:'bob',decision:'approve',digest:p.digest};
  p.reviews=[valid,{...valid},{...valid,reviewerId:'atlas'},{...valid,reviewerId:'old',digest:'0'.repeat(64)},{...valid,reviewerId:'disabled'}];
  const gate=readiness(p,context({activeAccountIds:['atlas','bob','steve']}));
  assert.equal(gate.approvalCount,1);assert.equal(gate.ready,false);
  p.reviews.push({...valid,reviewerId:'steve'});assert.equal(readiness(p,context({activeAccountIds:new Set(['atlas','bob','steve'])})).ready,true);
});

test('overlapping open proposals warn without mutual deadlock; a published update makes old bases stale',async()=>{
  const p=staged(approve(approve(await proposal(),bob),steve));
  const other={id:'second',title:'Another inbox fix',status:'staged',base:BASE,files:[{path:'inbox.css',content:'x'}]};
  const gate=readiness(p,context({proposals:[p,other]}));assert.equal(gate.ready,true);assert.equal(gate.warnings.length,1);assert.match(gate.warnings[0],/inbox\.css/);
  assert.equal(readiness(p,context({proposals:[{...other,status:'withdrawn'}]})).warnings.length,0);
  assert.equal(readiness(p,context({proposals:[{...other,status:'published'}],main:OTHER})).state,'blocked');
});

test('publishing, published and withdrawn proposals cannot be edited, reviewed, or published again',async()=>{
  const p=staged(approve(approve(await proposal(),bob),steve));
  for(const status of ['publishing','published','withdrawn']){
    const closed={...p,status};assert.equal(readiness(closed,context()).ready,false);
    await rejectsCode(()=>reviseProposal(closed,{...bundle(),expectedVersion:1},author,AT),'UPDATE_CLOSED');
    throwsCode(()=>approve(closed,bob),'UPDATE_CLOSED');
  }
  assert.deepEqual(readiness({...p,status:'publishing'},context({main:OTHER})).reasons,['This update is publishing.']);
  assert.equal(readiness({...p,status:'publishing'},context()).state,'publishing');
});

test('failed Pages deployment stays red after the source publication lock is released',async()=>{
  const published={...staged(await proposal()),status:'published',deployment:{state:'failure',summary:'Pages build failed.'}};
  const gate=readiness(published,context());assert.equal(gate.state,'blocked');assert.equal(gate.color,'red');assert.equal(gate.ready,false);assert.deepEqual(gate.reasons,['Pages build failed.']);
  const pending=staged(approve(approve(await proposal(),bob),steve));assert.equal(readiness(pending,context({proposals:[published]})).ready,true);
});

test('public projection does not leak server fields or alias mutable records',async()=>{
  const p=staged(approve(await proposal()));p.privateToken='server-secret';p.github.token='github-secret';p.checks.internalLog='hidden';p.reviews[0].internal='hidden';p.deployment={state:'pending',summary:'Deploying',url:'https://github.com/owner/repo/actions/runs/1',internal:'hidden'};p.publishStartedAt=AT;p.publishError='Pages pending';
  const visible=publicProposal(p,context());
  assert.equal(visible.privateToken,undefined);assert.equal(visible.github.token,undefined);assert.equal(visible.checks.internalLog,undefined);assert.equal(visible.reviews[0].internal,undefined);assert.equal(visible.readiness.state,'reviewing');
  assert.equal(visible.deployment.internal,undefined);assert.equal(visible.deployment.state,'pending');assert.equal(visible.publishStartedAt,AT);assert.equal(visible.publishError,'Pages pending');
  visible.files[0].content='mutated';visible.authorIds.push('someone');visible.reviews[0].body='changed';assert.notEqual(p.files[0].content,'mutated');assert.equal(p.authorIds.length,1);assert.notEqual(p.reviews[0].body,'changed');
});


test('default is one sign-off, manager mode excludes workers and agent mode requires two distinct workers',async()=>{
  const p=staged(await proposal()),accounts=[author,bob,steve,manager];
  const ctx=policy=>({connected:true,main:BASE,activeAccounts:accounts,policy});
  assert.equal(readiness(approve(p,bob),ctx({mode:'one',allowSelfApproval:false})).ready,true);
  assert.equal(readiness(approve(p,bob),ctx({mode:'manager',allowSelfApproval:false})).ready,false);
  assert.equal(readiness(approve(p,manager),ctx({mode:'manager',allowSelfApproval:false})).ready,true);
  assert.equal(readiness(approve(approve(p,bob),manager),ctx({mode:'agents',allowSelfApproval:false})).approvalCount,1);
  assert.equal(readiness(approve(approve(p,bob),steve),ctx({mode:'agents',allowSelfApproval:false})).ready,true);
  assert.equal(readiness(approve(p,bob),{connected:true,main:BASE}).requiredApprovals,1);
  for(const bad of [null,{},[],{mode:'bogus',allowSelfApproval:false},{mode:'one',allowSelfApproval:'true'}])throwsCode(()=>approvalPolicy(bad),'INVALID_POLICY');
});

test('worker self-sign-off is opt-in, exact-version and distinct; manager can approve its own',async()=>{
  const p=staged(await proposal()),policy={mode:'agents',allowSelfApproval:true};
  const self=reviewProposal(p,{digest:p.digest,decision:'approve'},author,AT,policy);
  assert.equal(mayReview(p,author,policy),true);assert.equal(mayReview(p,author,{...policy,allowSelfApproval:false}),false);
  const ctx={connected:true,main:BASE,activeAccounts:[author,bob,manager],policy};
  assert.equal(readiness(self,ctx).approvalCount,1);assert.equal(readiness(self,ctx).ready,false);
  assert.equal(readiness(reviewProposal(self,{digest:p.digest,decision:'approve'},author,AT,policy),ctx).approvalCount,1);
  assert.equal(readiness(approve(self,bob),ctx).ready,true);
  assert.equal(readiness(approve(self,bob),{...ctx,policy:{...policy,allowSelfApproval:false}}).ready,false);
  assert.equal(readiness({...self,reviews:[{...self.reviews[0],digest:'f'.repeat(64)}]},ctx).approvalCount,0);
  assert.equal(mayReview({...p,authorId:manager.id,authorIds:[manager.id]},manager,{mode:'manager',allowSelfApproval:false}),true);
});

test('manager override bypasses review count and objections but retains every technical gate',async()=>{
  const p=staged(await proposal()),ctx={connected:true,main:BASE,managerOverride:true};
  assert.equal(readiness(p,ctx).ready,true);
  const objection=reviewProposal(p,{digest:p.digest,decision:'changes',body:'Please change this.'},bob,AT);
  assert.equal(readiness(objection,ctx).ready,true);
  for(const bad of [{...p,base:OTHER},{...p,checks:{state:'failure'}},{...p,checks:{state:'pending'}},{...p,status:'draft'}])assert.equal(readiness(bad,ctx).ready,false);
  assert.equal(readiness(p,{...ctx,proposals:[{...p,id:'other',status:'publishing'}]}).ready,false);
});

const combination=(sources,extra={})=>({id:crypto.randomUUID(),base:BASE,selected:sources.map(({id,digest})=>({id,digest})),...extra});
const combine=(sources,user=manager,extra={})=>combineProposals(combination(sources,extra),sources,user,AT);

test('combined release resolves full files and contributors, deduplicates identical replacements, and leaves sources untouched',async()=>{
  const first=await createProposal(bundle({title:'Inbox layout',files:[{path:'shared.css',content:'.shared {}'},{path:'inbox.js',content:'export const inbox = 1;'}]}),author,AT);
  const second=await createProposal(bundle({title:'Board layout',files:[{path:'shared.css',content:'.shared {}'},{path:'board.css',content:'.board {}'}]}),bob,AT);
  const original=structuredClone([first,second]);
  const release=await combine([first,second]);
  assert.equal(release.kind,'release');assert.equal(release.title,'Next site update');assert.equal(release.status,'draft');assert.equal(release.authorId,'manager');assert.equal(release.version,1);
  assert.deepEqual(release.files.map(file=>file.path),['board.css','inbox.js','shared.css']);
  assert.deepEqual(new Set(release.authorIds),new Set(['atlas','bob']));
  assert.equal(release.sources.length,2);assert.deepEqual(new Set(release.sources.map(source=>source.digest)),new Set([first.digest,second.digest]));
  assert.match(release.description,/Inbox layout/);assert.match(release.description,/Board layout/);
  assert.deepEqual(release.reviews,[]);assert.equal(release.github,undefined);assert.deepEqual([first,second],original);
});

test('active workers may prepare releases but guests and disabled accounts cannot',async()=>{
  const first=await proposal();
  assert.equal((await combine([first],bob)).authorId,'bob');
  for(const bad of [null,{...bob,role:'guest'},{...bob,enabled:false},{...bob,disabled:true}])await rejectsCode(()=>combine([first],bad),'FORBIDDEN');
});

test('release digests bind exact source identities and versions and are deterministic across input order',async()=>{
  const first=await proposal(),second=await createProposal(bundle({files:[{path:'board.css',content:'.board {}'}]}),bob,AT);
  const release=await combine([first,second]),reverse=await combine([second,first]);
  assert.equal(release.digest,reverse.digest);assert.notEqual(release.id,reverse.id);
  const sameFilesDifferentSource=await createProposal({...bundle(),files:first.files},author,AT);
  assert.equal(sameFilesDifferentSource.digest,first.digest);
  const replacement=await combine([sameFilesDifferentSource,second]);assert.notEqual(release.digest,replacement.digest);
});

test('different complete replacements report every conflicting path without merging arbitrary content',async()=>{
  const first=await createProposal(bundle({files:[{path:'a.js',content:'first'},{path:'b.css',content:'first'}]}),author,AT);
  const second=await createProposal(bundle({files:[{path:'a.js',content:'second'},{path:'b.css',content:'second'}]}),bob,AT);
  await assert.rejects(()=>combine([first,second]),error=>error instanceof UpdatePolicyError&&error.code==='FILE_CONFLICT'&&error.status===409&&assert.deepEqual(error.paths,['a.js','b.css'])===undefined);
});

test('combined bundles enforce aggregate byte and file limits and cross-source path casing',async()=>{
  const make=files=>createProposal(bundle({files}),author,AT);
  const largeA=await make([{path:'a.txt',content:'x'.repeat(200000)},{path:'b.txt',content:'x'.repeat(200000)}]);
  const largeB=await make([{path:'c.txt',content:'x'.repeat(200000)},{path:'d.txt',content:'x'.repeat(200000)}]);
  await rejectsCode(()=>combine([largeA,largeB]),'BUNDLE_LIMIT');
  const manyA=await make(Array.from({length:21},(_,i)=>({path:`a${i}.txt`,content:''}))),manyB=await make(Array.from({length:20},(_,i)=>({path:`b${i}.txt`,content:''})));
  await rejectsCode(()=>combine([manyA,manyB]),'FILE_LIMIT');
  for(const paths of [['A.css','a.css'],['Assets/a.js','assets/b.js'],['data.json','data.json/file.js']]){
    const sources=await Promise.all(paths.map(path=>make([{path,content:'same'}])));
    await rejectsCode(()=>combine(sources),'DUPLICATE_PATH');
  }
});

test('selection references must be unique, present, current, editable and from the exact common base',async()=>{
  const first=await proposal(),input=combination([first]);
  await rejectsCode(()=>combineProposals({...input,selected:[]},[first],manager,AT),'INVALID_SELECTION');
  await rejectsCode(()=>combineProposals({...input,selected:Array.from({length:13},()=>input.selected[0])},[first],manager,AT),'INVALID_SELECTION');
  await rejectsCode(()=>combineProposals({...input,selected:[input.selected[0],input.selected[0]]},[first],manager,AT),'INVALID_SELECTION');
  await rejectsCode(()=>combineProposals({...input,selected:[{id:'fake',digest:first.digest}]},[first],manager,AT),'INVALID_SELECTION');
  await rejectsCode(()=>combineProposals({...input,selected:[{id:first.id,digest:'f'.repeat(64)}]},[first],manager,AT),'SOURCE_CHANGED');
  await rejectsCode(()=>combineProposals(input,[],manager,AT),'SOURCE_MISSING');
  for(const status of ['publishing','published','withdrawn'])await rejectsCode(()=>combineProposals(input,[{...first,status}],manager,AT),'SOURCE_CLOSED');
  await rejectsCode(()=>combineProposals({...input,base:OTHER},[first],manager,AT),'SOURCE_BASE');
  await rejectsCode(()=>combineProposals({...input,base:'main'},[first],manager,AT),'INVALID_BASE');
  await rejectsCode(()=>combineProposals({...input,id:'fake'},[first],manager,AT),'INVALID_ID');
});

test('release references cannot point to themselves, nested releases or an existing individual proposal ID',async()=>{
  const first=await proposal(),release=await combine([first]);
  await rejectsCode(()=>combineProposals(combination([first],{id:first.id}),[first],manager,AT),'INVALID_RELEASE');
  await rejectsCode(()=>combineProposals({...combination([first]),selected:[{id:release.id,digest:release.digest}]},[first,release],manager,AT),'INVALID_SELECTION');
  await rejectsCode(()=>combineProposals(combination([release],{id:release.id}),[first,release],manager,AT),'INVALID_SELECTION');
  await rejectsCode(()=>combine([{...first,sources:[]}]),'INVALID_SELECTION');
  await rejectsCode(()=>createProposal(bundle({kind:'release',sources:[]}),manager,AT),'INVALID_RELEASE');
});

test('release retries preserve staged metadata and reviews only when the complete source-bound digest matches',async()=>{
  const first=await proposal(),input=combination([first]),release=staged(approve(await combineProposals(input,[first],manager,AT),manager));
  const retry=await combineProposals(input,[first,release],bob,'2026-10-03T00:00:00Z');
  assert.deepEqual(retry,release);assert.notEqual(retry,release);retry.reviews[0].body='mutated';assert.notEqual(retry.reviews[0].body,release.reviews[0].body);
  await rejectsCode(()=>combineProposals({...input,title:'Changed release'},[first,release],manager,AT),'VERSION_CONFLICT');
});

test('rebuilding an exact current release resets reviews and checks and preserves the creator only as attribution',async()=>{
  const first=await proposal(),input=combination([first]),release=staged(approve(await combineProposals(input,[first],manager,AT),manager));
  const changed=await reviseProposal(first,{...bundle({files:[{path:'inbox.css',content:'changed'}]}),expectedVersion:first.version,expectedDigest:first.digest},author,AT);
  const revisedInput={...input,selected:[{id:changed.id,digest:changed.digest}],expectedVersion:release.version,expectedDigest:release.digest};
  const rebuilt=await combineProposals(revisedInput,[changed,release],steve,'2026-10-03T00:00:00Z');
  assert.equal(rebuilt.id,release.id);assert.equal(rebuilt.version,2);assert.equal(rebuilt.createdAt,release.createdAt);assert.notEqual(rebuilt.updatedAt,release.updatedAt);assert.equal(rebuilt.authorId,'manager');
  assert.deepEqual(new Set(rebuilt.authorIds),new Set(['atlas']));assert.equal(mayReview(rebuilt,steve),true);
  assert.notEqual(rebuilt.digest,release.digest);assert.deepEqual(rebuilt.reviews,[]);assert.equal(rebuilt.status,'draft');assert.equal(rebuilt.github,undefined);assert.equal(rebuilt.checks,undefined);
  for(const extra of [{expectedVersion:0},{expectedDigest:'f'.repeat(64)},{expectedDigest:undefined}])await rejectsCode(()=>combineProposals({...revisedInput,...extra},[changed,release],manager,AT),'VERSION_CONFLICT');
  await rejectsCode(()=>reviseProposal(release,{...bundle(),expectedVersion:1,expectedDigest:release.digest},manager,AT),'INVALID_RELEASE');
  await rejectsCode(()=>combineProposals(revisedInput,[changed,{...release,status:'publishing'}],manager,AT),'UPDATE_CLOSED');
});

test('a noncontributing worker can prepare and review the shared release while every source code author stays excluded',async()=>{
  const first=await proposal(),second=await createProposal(bundle({files:[{path:'board.css',content:'board'}]}),bob,AT);
  const release=staged(await combine([first,second],steve));
  assert.equal(release.authorId,'steve');assert.deepEqual(new Set(release.authorIds),new Set(['atlas','bob']));
  assert.equal(mayReview(release,steve,{mode:'one',allowSelfApproval:false}),true);
  for(const sourceAuthor of [author,bob])assert.equal(mayReview(release,sourceAuthor,{mode:'one',allowSelfApproval:false}),false);
  const reviewed=approve(release,steve),ctx=context({proposals:[first,second,reviewed],policy:{mode:'one',allowSelfApproval:false}});
  assert.equal(readiness(reviewed,ctx).ready,true);assert.equal(readiness(reviewed,ctx).approvalCount,1);
  assert.deepEqual(new Set(publicProposal(release,ctx).authorIds),new Set(['atlas','bob']));
});

test('source approvals never approve the release and all source authors are excluded unless self-sign-off is enabled',async()=>{
  const first=approve(await proposal(),steve),second=approve(await createProposal(bundle({files:[{path:'board.css',content:'board'}]}),bob,AT),steve);
  const release=staged(await combine([first,second]));
  assert.deepEqual(release.reviews,[]);assert.equal(mayReview(release,author),false);assert.equal(mayReview(release,bob),false);assert.equal(mayReview(release,steve),true);
  assert.equal(readiness(release,context({proposals:[first,second,release]})).approvalCount,0);
  const independent=approve(release,steve);
  assert.equal(readiness(independent,context({proposals:[first,second,release],policy:{mode:'one',allowSelfApproval:false}})).ready,true);
  throwsCode(()=>approve(release,bob),'REVIEW_FORBIDDEN');
  const policy={mode:'agents',allowSelfApproval:true},self=reviewProposal(release,{digest:release.digest,decision:'approve'},bob,AT,policy);
  assert.equal(readiness(self,context({proposals:[first,second,release],policy})).approvalCount,1);
});

test('release readiness blocks missing, changed and closed source records even with manager approval override',async()=>{
  const first=await proposal(),release=staged(await combine([first]));
  const ctx=sources=>context({proposals:[...sources,release],managerOverride:true});
  assert.equal(readiness(release,ctx([first])).ready,true);
  const cases=[
    [[], 'SOURCE_MISSING'],
    [[{...first,digest:'f'.repeat(64)}],'SOURCE_CHANGED'],
    [[{...first,version:2}],'SOURCE_CHANGED'],
    [[{...first,base:OTHER}],'SOURCE_CHANGED'],
    [[{...first,status:'withdrawn'}],'SOURCE_CLOSED'],
    [[{...first,status:'published',releaseId:crypto.randomUUID()}],'SOURCE_CLOSED']
  ];
  for(const [sources,code] of cases){const gate=readiness(release,ctx(sources));assert.equal(gate.ready,false,code);assert.ok(gate.blockers.some(item=>item.code===code),code);}
  assert.equal(readiness(release,ctx([{...first,status:'published',releaseId:release.id}])).ready,true);
});

test('an additional pending contribution invalidates an all-pending release until rebuilt',async()=>{
  const first=await proposal(),release=staged(await combine([first])),second=await createProposal(bundle({files:[{path:'board.css',content:'board'}]}),bob,AT);
  const ctx=extra=>context({proposals:[first,release,...extra],managerOverride:true});
  const gate=readiness(release,ctx([second]));assert.equal(gate.ready,false);assert.ok(gate.blockers.some(item=>item.code==='NEW_SOURCES'));
  for(const status of ['published','withdrawn'])assert.equal(readiness(release,ctx([{...second,status}])).ready,true);
  assert.equal(readiness({...release,status:'published'},ctx([second])).state,'published');
});

test('source-release overlap warnings are suppressed in both directions while unrelated overlaps still warn',async()=>{
  const first=staged(await proposal()),release=staged(await combine([first])),other=await createProposal(bundle(),bob,AT);
  const ctx=context({proposals:[first,release,other],managerOverride:true});
  assert.equal(readiness(first,ctx).warnings.length,1);assert.equal(readiness(release,ctx).warnings.length,1);
  const solo=context({proposals:[first,release],managerOverride:true});assert.deepEqual(readiness(first,solo).warnings,[]);assert.deepEqual(readiness(release,solo).warnings,[]);
});

test('release public projection whitelists copied source details and publication linkage',async()=>{
  const first=await proposal(),release=await combine([first]);release.sources[0].privateToken='hidden';release.privateToken='hidden';
  const visible=publicProposal(release,context({proposals:[first,release]}));assert.equal(visible.kind,'release');assert.equal(visible.privateToken,undefined);assert.equal(visible.sources[0].privateToken,undefined);
  visible.sources[0].title='mutated';assert.notEqual(visible.sources[0].title,release.sources[0].title);
  assert.equal(publicProposal({...first,releaseId:release.id},context()).releaseId,release.id);
});
