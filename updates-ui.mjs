// Update drafts stay in memory. Server decisions are authoritative for reviews and publishing.
const UPDATE_LIMITS={files:40,total:750000,file:200000};
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const encoder=new TextEncoder();
const allowedExtensions=/\.(html|css|mjs|js|svg|json|md|txt)$/i;
const protectedRoots=new Set(['backend','.github','tests','scripts','node_modules']);
const protectedFiles=new Set(['config.mjs','agents.md','readme.md','updates-policy.mjs','bridge.mjs','relay-cli.mjs','github.mjs']);
const stamp=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});};
function githubLink(value,label){try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='github.com'&&!url.username&&!url.password?`<a class="updates-link" href="${escapeHTML(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)} ↗</a>`:'';}catch{return '';}}
function validateFiles(files){
  if(!Array.isArray(files)||!files.length)throw new Error('Add at least one text file.');
  if(files.length>UPDATE_LIMITS.files)throw new Error('An update can contain up to 40 files.');
  const seen=new Set();let total=0;
  return files.map(file=>{
    if(!file||typeof file.path!=='string'||typeof file.content!=='string')throw new Error('Each file needs a path and text content.');
    const path=file.path;
    if(!path||path.length>240||! /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)||path.split('/').some(part=>!part||part.startsWith('.')))throw new Error(`Use a relative repository path for ${path||'each file'}.`);
    const lower=path.toLowerCase(),segments=lower.split('/'),filename=segments.at(-1);
    if(segments.some(segment=>protectedRoots.has(segment))||protectedFiles.has(filename)||/^package.*\.json$/i.test(filename))throw new Error(`${path} is maintained separately from the Update room.`);
    if(!allowedExtensions.test(path))throw new Error(`${path} is not a supported text file. Use HTML, CSS, JS, MJS, SVG, JSON, MD, or TXT.`);
    if(seen.has(lower))throw new Error(`The path ${path} appears more than once.`);
    if(file.content.includes('\0'))throw new Error(`${path} contains binary data. Upload text source files only.`);
    const bytes=encoder.encode(file.content).length;
    if(bytes>UPDATE_LIMITS.file)throw new Error(`${path} is larger than 200,000 bytes.`);
    total+=bytes;seen.add(lower);return {path,content:file.content};
  }).map(file=>{if(total>UPDATE_LIMITS.total)throw new Error('The files in one update must total no more than 750,000 bytes.');return file;});
}

export function createUpdates({api,getUser,isLive,toast=()=>{},onSessionError=()=>{}}){
  let data={proposals:[],repository:{main:'',connected:false},requiredApprovals:2};
  let loaded=false,error='',notice='',selectedId=null,composing=false,busy='',generation=0,refreshSequence=0,draftRevision=0,uploadSequence=0,polling=false,refreshing=0;
  const reviews=new Map(),paintedHTML=new WeakMap();
  const blankDraft=()=>({id:crypto.randomUUID(),title:'',description:'',base:data.repository?.main||'',files:[]});
  let draft=blankDraft();
  const root=()=>document.querySelector('#updates-root');
  const user=()=>getUser?.();
  const live=()=>Boolean(isLive?.()&&user()?.id);
  const session=()=>({generation,token:api.token,userId:user()?.id});
  const current=ctx=>ctx.generation===generation&&ctx.token===api.token&&ctx.userId===user()?.id&&live();
  const proposal=()=>data.proposals.find(p=>p.id===selectedId);
  const authorList=p=>[p.authorId,...(Array.isArray(p.authorIds)?p.authorIds:[])];
  const authored=p=>authorList(p).includes(user()?.id);
  const closed=p=>['published','withdrawn'].includes(p.status);
  const stateOf=p=>p.status==='published'?(p.deployment?.state==='failure'?'blocked':'published'):p.status==='withdrawn'?'withdrawn':!data.repository?.connected?'blocked':p.readiness?.state==='ready'&&p.status==='staged'?'ready':p.readiness?.state==='blocked'?'blocked':'reviewing';
  const stateLabels={blocked:'Blocked',reviewing:'Reviewing',ready:'Ready to update',published:'Published',withdrawn:'Withdrawn'};
  const badge=p=>{const state=stateOf(p);return `<span class="updates-state ${state}"><span aria-hidden="true"></span>${p.deployment?.state==='failure'?'Deployment failed':p.status==='publishing'?'Publishing':p.deployment?.state==='superseded'?'Newer release available':stateLabels[state]}</span>`;};
  const reviewKey=p=>`${p.id}:${p.digest}`;
  const message=()=>{const node=root()?.querySelector('#updates-feedback');if(node){node.textContent=error||notice;node.classList.toggle('has-error',Boolean(error));node.setAttribute('role',error?'alert':'status');}};
  function fail(err,ctx){if(!current(ctx))return;if(['SESSION','UNAUTHORIZED','STALE_SESSION','DELETED'].includes(err.code)){reset();onSessionError();return;}error=err.message||'Something went wrong. Try again.';notice='';message();}
  function topHTML(){
    const repository=data.repository||{},ready=data.proposals.filter(p=>stateOf(p)==='ready').length,open=data.proposals.filter(p=>!closed(p)).length;
    return `<div class="updates-overview"><div class="updates-connection ${repository.connected?'connected':'disconnected'}"><span class="updates-connection-dot" aria-hidden="true"></span><div><strong>${repository.connected?'Publishing connected':'Publishing setup pending'}</strong><p>${repository.connected?'Reviewed updates can be published by the manager.':'Drafts and reviews are available. Connect the publisher before updating the live site.'}</p>${repository.error?`<p class="updates-connection-error">${escapeHTML(repository.error)}</p>`:''}</div></div><div class="updates-counts"><span><strong>${open}</strong> open</span><span><strong>${ready}</strong> ready</span></div></div><div class="updates-flow" aria-label="Update process"><span><b>1</b> Submit files</span><span><b>2</b> Review &amp; check</span><span><b>3</b> Manager updates site</span></div>`;
  }
  function listHTML(){
    if(!loaded)return '<div class="updates-list-empty">Loading updates…</div>';
    if(!data.proposals.length)return '<div class="updates-list-empty"><strong>No updates yet</strong><p>Submit a set of changes for your teammates to review.</p></div>';
    return data.proposals.map(p=>`<button type="button" class="updates-proposal ${!composing&&selectedId===p.id?'selected':''}" data-update-select="${escapeHTML(p.id)}" aria-current="${!composing&&selectedId===p.id?'true':'false'}">${badge(p)}<strong>${escapeHTML(p.title)}</strong><span>${escapeHTML(p.authorName||'Worker')} · Version ${escapeHTML(p.version??1)}</span><time>${escapeHTML(stamp(p.createdAt))}</time></button>`).join('');
  }
  function draftFilesHTML(){return draft.files.length?draft.files.map((f,i)=>`<details class="updates-draft-file" data-update-open="draft-file-${i}"><summary><span>${escapeHTML(f.path)}</span><small>${encoder.encode(f.content).length.toLocaleString()} bytes</small></summary><div class="updates-file-editor"><label class="field"><span class="field-label">Repository path</span><input data-update-path="${i}" aria-label="Path for file ${i+1}" value="${escapeHTML(f.path)}" autocomplete="off" spellcheck="false" required></label><label class="field"><span class="field-label">File contents</span><textarea data-update-source="${i}" aria-label="Contents of ${escapeHTML(f.path)}" spellcheck="false" rows="10">${escapeHTML(f.content)}</textarea></label><button class="button small danger" type="button" data-update-remove="${i}">Remove file</button></div></details>`).join(''):'<p class="updates-hint">No files added yet. Uploaded files replace those paths in the repository; other files stay unchanged.</p>';}
  function formHTML(){return `<section class="updates-detail updates-compose" aria-labelledby="updates-compose-title"><div class="updates-detail-heading"><div><div class="eyebrow">${draft.expectedVersion?'REPLACE A VERSION':'NEW UPDATE'}</div><h2 id="updates-compose-title">${draft.expectedVersion?'Revise this update':'Share your changes'}</h2></div><button class="button small" type="button" data-update-action="cancel-compose">Close</button></div><p class="updates-hint">Submit source files together. Two other accounts review the exact version, and checks must pass before the manager can publish.</p><form id="updates-submit-form"><label class="field"><span class="field-label">Update title</span><input name="title" required maxlength="180" value="${escapeHTML(draft.title)}" placeholder="What does this update improve?" autocomplete="off"></label><label class="field"><span class="field-label">What changed and how was it checked?</span><textarea name="description" required maxlength="8000" rows="3" placeholder="Explain the change and your testing.">${escapeHTML(draft.description)}</textarea></label><label class="field"><span class="field-label">Starting commit</span><input name="base" required pattern="[a-fA-F0-9]{40}" maxlength="40" value="${escapeHTML(draft.base)}" placeholder="40-character commit SHA" autocomplete="off" spellcheck="false"><span class="updates-hint">Use the exact commit your changes started from.${data.repository?.main?` Current main: <code>${escapeHTML(data.repository.main)}</code>`:''}</span></label><div class="updates-upload-grid"><label class="field updates-upload"><span class="field-label">Import an update bundle</span><span class="updates-hint">One JSON file containing title, description, base, and files.</span><input type="file" id="updates-bundle" accept=".json,application/json" aria-label="Import an update bundle"></label><label class="field updates-upload"><span class="field-label">Add source files</span><span class="updates-hint">Upload text files, then adjust folder paths below.</span><input type="file" id="updates-files" multiple accept=".html,.css,.mjs,.js,.svg,.json,.md,.txt" aria-label="Add source files"></label></div><div id="updates-draft-files">${draftFilesHTML()}</div><details class="updates-format" data-update-open="bundle-format"><summary>Bundle format and limits</summary><pre><code>${escapeHTML(JSON.stringify({title:'Describe the change',description:'What changed and how you tested it',base:'The exact 40-character starting commit',files:[{path:'example.css',content:'/* Full replacement file contents */'}]},null,2))}</code></pre><p class="updates-hint">Up to 40 text files, 200,000 bytes per file, 750,000 bytes total. Publishing, authentication, backend, and test configuration are maintained separately.</p></details><div class="updates-submit-actions"><button class="button" type="button" data-update-action="download-draft" ${draft.files.length?'':'disabled'}>Download draft</button><button class="button primary" type="submit" ${busy?'disabled':''}>${busy==='submit'?'Submitting…':draft.expectedVersion?'Submit revised version':'Submit for review'}</button></div><p class="updates-hint">${draft.expectedVersion?'Replacing this version clears earlier approvals and check results.':'Only submitted files are shared with the team.'} Unsubmitted drafts stay in this tab until you sign out or reload.</p></form></section>`;}
  function detailHTML(){
    if(composing)return formHTML();
    const p=proposal();
    if(!p)return '<section class="updates-detail updates-empty"><div class="updates-empty-icon" aria-hidden="true">↑</div><h2>A shared place to prepare the next update.</h2><p>Select an update to review its files, checks, and sign-offs. The manager decides when ready changes go live.</p><button class="button primary" type="button" data-update-action="new">Submit an update</button></section>';
    const state=stateOf(p),isClosed=closed(p),isAuthor=authored(p),isManager=user()?.role==='manager',required=Number.isInteger(p.readiness?.requiredApprovals)?p.readiness.requiredApprovals:Number.isInteger(data.requiredApprovals)?data.requiredApprovals:2;
    const validReviews=[...new Map((p.reviews||[]).filter(r=>r.digest===p.digest).map(r=>[r.reviewerId,r])).values()],approvals=Number.isInteger(p.readiness?.approvalCount)?p.readiness.approvalCount:validReviews.filter(r=>r.decision==='approve'&&!authorList(p).includes(r.reviewerId)).length;
    const review=reviews.get(reviewKey(p))||'',canReview=!isClosed&&p.status!=='publishing'&&!isAuthor,canPublish=state==='ready'&&isManager&&!busy;
    const reasons=[...(!data.repository?.connected&&!isClosed?['Publishing connection needs to be set up.']:[]),...(p.readiness?.reasons||[]),...(p.publishError?[p.publishError]:[])];
    const checks=p.checks||{state:'pending',summary:'Checks have not run yet.'},checkLabel=checks.state==='success'?'Checks passed':checks.state==='failure'?'Checks failed':'Checks pending';
    return `<section class="updates-detail" aria-labelledby="updates-detail-title"><div class="updates-detail-heading"><div><div class="eyebrow">VERSION ${escapeHTML(p.version??1)} · ${escapeHTML(p.authorName||'WORKER')}</div><h2 id="updates-detail-title">${escapeHTML(p.title)}</h2></div>${badge(p)}</div><p class="updates-description">${escapeHTML(p.description)}</p><div class="updates-readiness ${state}"><div><h3>${p.deployment?.state==='failure'?'The live-site deployment failed':p.deployment?.state==='superseded'?'A newer release is available':state==='ready'?'Ready for the manager’s approval':state==='published'?'This update is published':state==='withdrawn'?'This update was withdrawn':p.status==='publishing'?'Publishing this update…':state==='blocked'?'This update needs attention':'Preparing this update'}</h3><p>${p.deployment?.state==='failure'?'The source was merged, but the live-site deployment failed. Open the deployment details to investigate.':p.deployment?.state==='superseded'?'This version was merged. A newer release has since moved the site forward.':state==='ready'?'The reviewed version passed the required checks.':state==='published'?'This version has been merged into the site’s main branch.':state==='withdrawn'?'This version will not be published.':'Reviews and check results apply only to this exact version.'}</p></div>${reasons.length?`<ul>${[...new Set(reasons)].map(reason=>`<li>${escapeHTML(reason)}</li>`).join('')}</ul>`:''}${(p.readiness?.warnings||[]).length?`<div class="updates-warnings"><strong>Coordination notes</strong><ul>${p.readiness.warnings.map(w=>`<li>${escapeHTML(w)}</li>`).join('')}</ul></div>`:''}</div><div class="updates-check-grid"><div><span class="updates-check-icon ${approvals>=required?'complete':''}" aria-hidden="true">${approvals>=required?'✓':'○'}</span><div><strong>${approvals} of ${required} sign-offs</strong><p>From accounts that did not author this version</p></div></div><div><span class="updates-check-icon ${checks.state==='success'?'complete':checks.state==='failure'?'failed':''}" aria-hidden="true">${checks.state==='success'?'✓':checks.state==='failure'?'!':'○'}</span><div><strong>${checkLabel}</strong><p>${escapeHTML(checks.summary||'Run checks to prepare this version.')}</p>${githubLink(checks.url,'View checks')}</div></div>${p.deployment?`<div class="updates-deployment"><span class="updates-check-icon ${p.deployment.state==='success'?'complete':p.deployment.state==='failure'?'failed':''}" aria-hidden="true">${p.deployment.state==='success'?'✓':p.deployment.state==='failure'?'!':'○'}</span><div><strong>${p.deployment.state==='success'?'Live-site deployment complete':p.deployment.state==='failure'?'Live-site deployment failed':p.deployment.state==='superseded'?'Follow the newer release':'Live-site deployment pending'}</strong><p>${escapeHTML(p.deployment.summary||'Refresh status to follow deployment progress.')}</p>${githubLink(p.deployment.url,'View deployment')}</div></div>`:''}</div><div class="updates-version"><span>Starting commit <code title="${escapeHTML(p.base)}">${escapeHTML((p.base||'').slice(0,12))}</code></span><span>Version digest <code title="${escapeHTML(p.digest)}">${escapeHTML((p.digest||'').slice(0,12))}</code></span>${githubLink(p.github?.url,'Open code review')}</div><section class="updates-files-section" aria-labelledby="updates-files-title"><div class="updates-section-heading"><h3 id="updates-files-title">Files in this version <span>${(p.files||[]).length}</span></h3><button class="button small" type="button" data-update-action="download">Download bundle</button></div>${(p.files||[]).map((f,i)=>`<details class="updates-source" data-update-open="source-${escapeHTML(p.id)}-${i}"><summary><span>${escapeHTML(f.path)}</span><small>${encoder.encode(f.content||'').length.toLocaleString()} bytes</small></summary><pre tabindex="0" aria-label="Source of ${escapeHTML(f.path)}"><code>${escapeHTML(f.content)}</code></pre></details>`).join('')}</section><section class="updates-reviews-section" aria-labelledby="updates-reviews-title"><h3 id="updates-reviews-title">Team review</h3>${validReviews.length?`<ul class="updates-reviews">${validReviews.map(r=>`<li><div><strong>${escapeHTML(r.reviewerName||'Worker')}</strong><span class="updates-review-decision ${r.decision==='approve'?'approved':'changes'}">${r.decision==='approve'?'Signed off':'Changes requested'}</span></div>${r.body?`<p>${escapeHTML(r.body)}</p>`:''}</li>`).join('')}</ul>`:'<p class="updates-hint">No sign-offs for this version yet.</p>'}${canReview?`<form id="updates-review-form"><label class="field"><span class="field-label">Review notes</span><textarea name="body" maxlength="4000" rows="3" placeholder="What did you check? What needs changing?">${escapeHTML(review)}</textarea></label><div class="updates-review-actions"><button class="button" type="submit" value="changes" ${busy?'disabled':''}>Request changes</button><button class="button" type="submit" value="approve" ${busy?'disabled':''}>Sign off this version</button></div></form>`:isAuthor&&!isClosed?'<p class="updates-hint">You authored this version. Two other accounts need to sign off.</p>':''}</section><div class="updates-publish-bar"><div><strong>${isManager?'Your approval controls publication':'The manager publishes ready updates'}</strong><p>${p.status==='publishing'?'Check progress below.':isManager?'“Update site” publishes this exact reviewed version.':'A green indicator means the update is ready for the manager.'}</p></div>${isManager?`<button class="button primary" type="button" data-update-action="publish" ${canPublish?'':'disabled'}>${p.status==='publishing'?'Publishing…':'Update site'}</button>`:''}</div><div class="updates-detail-actions">${!isClosed&&p.status!=='publishing'?`<button class="button" type="button" data-update-action="stage" ${busy||!data.repository?.connected?'disabled':''}>${p.github?.head?'Run checks again':'Run checks'}</button>`:''}<button class="button" type="button" data-update-action="check" ${busy?'disabled':''}>Refresh status</button>${!isClosed&&p.status!=='publishing'&&isAuthor?`<button class="button" type="button" data-update-action="revise" ${busy?'disabled':''}>Revise files</button>`:''}${!isClosed&&p.status!=='publishing'&&(isAuthor||isManager)?`<button class="button danger" type="button" data-update-action="withdraw" ${busy?'disabled':''}>Withdraw</button>`:''}</div></section>`;
  }
  function replaceHTML(node,html){
    if(!node||paintedHTML.get(node)===html)return;
    const details=[...node.querySelectorAll('details[data-update-open]')];
    const opens=details.filter(n=>n.open).map(n=>n.dataset.updateOpen);
    const sourceScroll=new Map(details.map(n=>[n.dataset.updateOpen,{top:n.querySelector('pre')?.scrollTop||0,left:n.querySelector('pre')?.scrollLeft||0}]));
    const focused=document.activeElement,hadFocus=node.contains(focused);
    const focusName=hadFocus?focused.getAttribute('name'):null;
    const focusAttribute=hadFocus?['data-update-action','data-update-select'].find(a=>focused.hasAttribute(a)):null;
    const focusValue=focusAttribute?focused.getAttribute(focusAttribute):null;
    const focusDetail=hadFocus?focused.closest('details[data-update-open]')?.dataset.updateOpen:null;
    const focusTag=hadFocus?focused.tagName:null;
    const selection=focusName&&typeof focused.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
    node.innerHTML=html;paintedHTML.set(node,html);
    node.querySelectorAll('details[data-update-open]').forEach(n=>{if(opens.includes(n.dataset.updateOpen))n.open=true;const pre=n.querySelector('pre'),scroll=sourceScroll.get(n.dataset.updateOpen);if(pre&&scroll){pre.scrollTop=scroll.top;pre.scrollLeft=scroll.left;}});
    let next;
    if(focusName)next=[...node.querySelectorAll('[name]')].find(n=>n.getAttribute('name')===focusName);
    else if(focusAttribute)next=[...node.querySelectorAll(`[${focusAttribute}]`)].find(n=>n.getAttribute(focusAttribute)===focusValue);
    else if(focusDetail&&['SUMMARY','PRE'].includes(focusTag))next=[...node.querySelectorAll('details[data-update-open]')].find(n=>n.dataset.updateOpen===focusDetail)?.querySelector(focusTag.toLowerCase());
    if(hadFocus&&(!next||next.disabled)){next=node.querySelector('h2, h3');if(next)next.tabIndex=-1;}
    if(next&&!next.disabled){next.focus({preventScroll:true});if(selection)next.setSelectionRange(...selection);}
  }
  function paint({detail=true}={}){const r=root();if(!r)return;const count=r.querySelector('#updates-proposal-count');if(count)count.textContent=data.proposals.length;replaceHTML(r.querySelector('#updates-overview'),topHTML());replaceHTML(r.querySelector('#updates-proposals'),listHTML());if(detail)replaceHTML(r.querySelector('#updates-detail'),detailHTML());message();bind();}
  async function refresh(){
    if(!live())return;const ctx=session(),sequence=++refreshSequence;refreshing++;
    try{const next=await api.call('updates.list');if(!current(ctx)||sequence!==refreshSequence)return;data={...next,proposals:Array.isArray(next.proposals)?next.proposals:[]};loaded=true;if(!draft.base&&data.repository?.main){draft.base=data.repository.main;const base=root()?.querySelector('#updates-submit-form [name="base"]');if(base&&!base.value)base.value=draft.base;}if(selectedId&&!data.proposals.some(p=>p.id===selectedId))selectedId=null;if(!selectedId&&!composing&&data.proposals.length)selectedId=data.proposals.find(p=>!closed(p))?.id||data.proposals[0].id;error='';paint({detail:!composing});}
    catch(err){fail(err,ctx);}
    finally{if(ctx.generation===generation)refreshing=Math.max(0,refreshing-1);}
  }
  async function poll(){
    if(!live()||document.hidden||!root()||busy||composing||polling||refreshing)return;
    const ctx=session(),p=proposal();polling=true;
    try{
      if(data.repository?.connected&&p&&['staged','publishing'].includes(p.status)){
        await api.call('updates.refresh',{id:p.id});
        if(!current(ctx))return;
      }
      if(!document.hidden&&root()&&!busy&&!composing)await refresh();
    }catch(err){fail(err,ctx);}
    finally{if(ctx.generation===generation)polling=false;}
  }
  function download(bundle){const blob=new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`relay-update-${String(bundle.title||'draft').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').slice(0,60)||'draft'}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const bundleFor=p=>({title:p.title,description:p.description,base:p.base,files:p.files});
  async function mutate(action,payload,label){
    if(busy||!live())return false;const ctx=session();busy=action;error='';notice='';paint({detail:!composing});const submit=root()?.querySelector('#updates-submit-form [type="submit"]');if(submit)submit.disabled=true;
    try{await api.call(`updates.${action}`,payload);if(!current(ctx))return false;notice=label;toast(label);await refresh();return current(ctx);}
    catch(err){fail(err,ctx);return false;}
    finally{if(current(ctx)){busy='';paint({detail:!composing});const button=root()?.querySelector('#updates-submit-form [type="submit"]');if(button){button.disabled=false;button.textContent=draft.expectedVersion?'Submit revised version':'Submit for review';}}}
  }
  function syncDraft(form){draft.title=form.elements.title.value;draft.description=form.elements.description.value;draft.base=form.elements.base.value;draftRevision++;}
  async function importFiles(input,bundle){
    const ctx=session(),sequence=++uploadSequence,revision=draftRevision,files=[...input.files];if(!files.length)return;error='';notice='';
    try{
      if(bundle){const file=files[0];if(file.size>1048576)throw new Error('The bundle is too large. Keep the JSON file under 1 MiB.');const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer()),value=JSON.parse(text);if(!current(ctx)||sequence!==uploadSequence||revision!==draftRevision)return;if(!value||typeof value.title!=='string'||typeof value.description!=='string'||typeof value.base!=='string')throw new Error('The bundle needs title, description, base, and files.');const checked=validateFiles(value.files);if(value.title.length>180||value.description.length>8000)throw new Error('The bundle title or description is too long.');if(!/^[a-fA-F0-9]{40}$/.test(value.base))throw new Error('The bundle needs the exact 40-character starting commit.');draft={...draft,title:value.title,description:value.description,base:value.base,files:checked};}
      else{if(files.some(f=>f.size>UPDATE_LIMITS.file))throw new Error('Each source file must be no larger than 200,000 bytes.');if(files.reduce((n,f)=>n+f.size,0)>UPDATE_LIMITS.total||files.length+draft.files.length>UPDATE_LIMITS.files)throw new Error('Use up to 40 files and 750,000 bytes in one update.');const additions=await Promise.all(files.map(async file=>({path:file.webkitRelativePath||file.name,content:new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer())})));if(!current(ctx)||sequence!==uploadSequence||revision!==draftRevision)return;draft.files=validateFiles([...draft.files,...additions]);}
      draftRevision++;notice=bundle?'Bundle loaded. Review it, then submit.':'Source files added. Check their repository paths.';paint();
    }catch(err){if(current(ctx)&&sequence===uploadSequence){error=err instanceof SyntaxError?'The bundle is not valid JSON.':err.message||'Could not read those files.';message();}}finally{if(input.isConnected)input.value='';}
  }
  function bind(){
    const r=root();if(!r)return;
    r.onclick=async event=>{
      if(!(event.target instanceof Element))return;
      const select=event.target.closest('[data-update-select]');if(select){selectedId=select.dataset.updateSelect;composing=false;error='';notice='';paint();return;}
      const remove=event.target.closest('[data-update-remove]');if(remove){draft.files.splice(Number(remove.dataset.updateRemove),1);draftRevision++;paint();return;}
      const button=event.target.closest('[data-update-action]');if(!button||button.disabled)return;
      const action=button.dataset.updateAction,p=proposal();
      if(action==='new'){composing=true;error='';notice='';paint();r.querySelector('[name="title"]')?.focus();return;}
      if(action==='cancel-compose'){composing=false;paint();return;}
      if(action==='refresh'){button.disabled=true;try{await refresh();}finally{if(button.isConnected)button.disabled=false;}return;}
      if(action==='download-draft'){download(bundleFor(draft));return;}
      if(!p)return;
      if(action==='download'){download(bundleFor(p));return;}
      if(action==='revise'){draft={...bundleFor(p),files:(p.files||[]).map(f=>({...f})),id:p.id,expectedVersion:p.version};draftRevision++;composing=true;paint();return;}
      if(action==='stage')await mutate('stage',{id:p.id,digest:p.digest},'Checks requested for this version.');
      if(action==='check')await mutate('refresh',{id:p.id},'Update status refreshed.');
      if(action==='publish'&&user()?.role==='manager'&&stateOf(p)==='ready')await mutate('publish',{id:p.id,digest:p.digest},'Publication requested. Refresh status to follow progress.');
      if(action==='withdraw')await mutate('withdraw',{id:p.id,digest:p.digest},'Update withdrawn.');
    };
    const form=r.querySelector('#updates-submit-form');
    if(form){
      form.oninput=event=>{const target=event.target;if(target.dataset.updatePath!==undefined){draft.files[Number(target.dataset.updatePath)].path=target.value;draftRevision++;}else if(target.dataset.updateSource!==undefined){draft.files[Number(target.dataset.updateSource)].content=target.value;draftRevision++;}else if(['title','description','base'].includes(target.name))syncDraft(form);};
      form.onsubmit=async event=>{event.preventDefault();if(busy)return;syncDraft(form);const revision=draftRevision,ctx=session();try{const payload={...bundleFor(draft),id:draft.id,files:validateFiles(draft.files),...(draft.expectedVersion!==undefined?{expectedVersion:draft.expectedVersion}:{})};if(!payload.title.trim()||!payload.description.trim())throw new Error('Add a title and describe the change.');if(!/^[a-fA-F0-9]{40}$/.test(payload.base))throw new Error('Enter the exact 40-character starting commit.');if(await mutate('submit',payload,'Update submitted for review.')){selectedId=payload.id;if(draftRevision===revision){draft=blankDraft();draftRevision++;composing=false;}paint();}}catch(err){fail(err,ctx);}};
      r.querySelector('#updates-bundle').onchange=e=>importFiles(e.target,true);
      r.querySelector('#updates-files').onchange=e=>importFiles(e.target,false);
    }
    const reviewForm=r.querySelector('#updates-review-form'),p=proposal();
    if(reviewForm&&p){const key=reviewKey(p);reviewForm.elements.body.oninput=e=>reviews.set(key,e.target.value);reviewForm.onsubmit=async event=>{event.preventDefault();const decision=event.submitter?.value;if(busy||!['approve','changes'].includes(decision)||authored(p))return;const body=reviewForm.elements.body.value;reviews.set(key,body);if(decision==='changes'&&!body.trim()){error='Describe what needs to change before requesting changes.';message();reviewForm.elements.body.focus();return;}if(await mutate('review',{id:p.id,digest:p.digest,decision,body},decision==='approve'?'Signed off this exact version.':'Changes requested.')){if(reviews.get(key)===body)reviews.delete(key);paint();}};}
  }
  function render(){return `<div class="page-title"><div><div class="eyebrow">CODERCODE / STUDIO</div><h1>Update room</h1><p class="subtitle">Prepare changes together. Review one version. Publish when you’re ready.</p></div>${live()?'<div class="updates-title-actions"><button class="button" type="button" data-update-external="refresh">Refresh</button><button class="button primary" type="button" data-update-external="new">New update</button></div>':''}</div>${!live()?'<div class="empty"><h3>Sign in to prepare updates</h3><p>Worker accounts submit and review changes. The manager publishes ready updates.</p></div>':`<div id="updates-root"><div id="updates-overview">${topHTML()}</div><p id="updates-feedback" class="updates-feedback ${error?'has-error':''}" role="${error?'alert':'status'}" aria-live="polite">${escapeHTML(error||notice)}</p><div class="updates-layout"><aside class="updates-sidebar" aria-label="Submitted updates"><div class="updates-sidebar-heading"><h2>Team updates</h2><span id="updates-proposal-count">${data.proposals.length}</span></div><div id="updates-proposals">${listHTML()}</div></aside><div id="updates-detail">${detailHTML()}</div></div></div>`}`;}
  function mount(){if(!live())return;bind();document.querySelectorAll('[data-update-external]').forEach(button=>{button.onclick=async()=>{if(button.dataset.updateExternal==='new'){composing=true;error='';notice='';paint();root()?.querySelector('[name="title"]')?.focus();}else{button.disabled=true;try{await refresh();}finally{if(button.isConnected)button.disabled=false;}}};});refresh();}
  function reset(){generation++;refreshSequence++;uploadSequence++;data={proposals:[],repository:{main:'',connected:false},requiredApprovals:2};loaded=false;error='';notice='';selectedId=null;composing=false;busy='';polling=false;refreshing=0;reviews.clear();draft=blankDraft();draftRevision++;}
  return {render,mount,reset,refresh,poll};
}
