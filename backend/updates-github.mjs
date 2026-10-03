// This module runs on the server only. No GitHub credential is returned to a client.
export const REPOSITORY='doublekingwasabi1819-a11y/doublekingwasabi1819-a11y.github.io';
const shaPattern=/^[a-f0-9]{40}$/;
const fail=(message,code='GITHUB',status=503)=>{throw Object.assign(new Error(message),{code,status});};
const base64url=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const encode=value=>base64url(new TextEncoder().encode(JSON.stringify(value)));

export function createGitHubPublisher({appId='',installationId='',privateKey='',fetcher=fetch,now=()=>Date.now()}={}){
  const configured=Boolean(appId&&installationId&&privateKey);let cachedToken=null;
  async function token(){
    if(!configured)fail('Publishing connection needs manager setup. Submissions and reviews are available.','NOT_CONFIGURED',409);
    if(cachedToken&&cachedToken.until>now()+60000)return cachedToken.value;
    // GitHub exports PKCS#1 keys; setup must supply a PKCS#8 PEM conversion.
    const pem=privateKey.replaceAll('\\n','\n');
    if(!pem.includes('BEGIN PRIVATE KEY'))fail('Publishing key must be PKCS#8. Ask the manager to finish setup.','NOT_CONFIGURED',409);
    const der=Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g,'')),c=>c.charCodeAt(0));
    const key=await crypto.subtle.importKey('pkcs8',der,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
    const at=Math.floor(now()/1000),unsigned=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iat:at-60,exp:at+480,iss:appId});
    const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(unsigned));
    const response=await fetcher(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${unsigned}.${base64url(new Uint8Array(signature))}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},body:JSON.stringify({repositories:[REPOSITORY.split('/')[1]],permissions:{contents:'write',pull_requests:'write',actions:'read',checks:'read'}})});
    if(!response.ok)fail('The GitHub publishing connection could not authenticate. Ask the manager to check the app installation.');
    const result=await response.json();cachedToken={value:result.token,until:Date.parse(result.expires_at)};return result.token;
  }
  async function request(path,{method='GET',body,publicRead=false,allow404=false}={}){
    let response;try{response=await fetcher('https://api.github.com/repos/'+REPOSITORY+path,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(configured||!publicRead?{Authorization:'Bearer '+await token()}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
    catch(e){if(e.code)throw e;fail('GitHub could not be reached. Refresh to check the latest result.','NETWORK');}
    if(allow404&&response.status===404)return null;
    if(!response.ok)fail(response.status===409||response.status===422?'GitHub changed or this update conflicts. Refresh before retrying.':'GitHub could not complete this update. Check the publishing connection.',response.status===409||response.status===422?'CONFLICT':'GITHUB',response.status===409||response.status===422?409:503);
    return response.status===204?{}:response.json();
  }
  async function repository(){const ref=await request('/git/ref/heads/main',{publicRead:true});return {name:REPOSITORY,main:ref.object.sha,connected:configured};}
  async function stage(p){
    if(!configured)await token();
    const repo=await repository();if(repo.main!==p.base)fail('The live site changed. Rebase and submit a new version first.','CONFLICT',409);
    const parent=await request('/git/commits/'+p.base);
    const tree=await request('/git/trees',{method:'POST',body:{base_tree:parent.tree.sha,tree:p.files.map(f=>({path:f.path,mode:'100644',type:'blob',content:f.content}))}});
    const commit=await request('/git/commits',{method:'POST',body:{message:`Relay update: ${p.title}\n\nProposal ${p.id} version ${p.version}\nBundle SHA256 ${p.digest}`,tree:tree.sha,parents:[p.base]}});
    const branch=`relay-update/${p.id}-v${p.version}-${p.digest.slice(0,12)}`;
    const old=await request('/git/ref/heads/'+branch,{allow404:true});
    if(old&&old.object.sha!==commit.sha){
      // A timed-out attempt may have created the same content under a different commit timestamp.
      const prior=await request('/git/commits/'+old.object.sha);
      if(prior.tree.sha!==tree.sha||prior.parents.length!==1||prior.parents[0].sha!==p.base)fail('The proposal branch was changed outside Relay. Submit a new version.','CONFLICT',409);
      commit.sha=old.object.sha;
    }else if(!old)await request('/git/refs',{method:'POST',body:{ref:'refs/heads/'+branch,sha:commit.sha}});
    const prs=await request('/pulls?state=open&head='+encodeURIComponent(REPOSITORY.split('/')[0]+':'+branch));
    const pr=prs[0]||await request('/pulls',{method:'POST',body:{title:p.title,head:branch,base:'main',body:`Submitted through Relay by ${p.authorName}.\n\n${p.description}\n\nBundle: ${p.digest}\nVersion: ${p.version}\n\nApproval rules are controlled by the manager in Relay. Trusted validation must pass on this exact commit. Only the studio manager can publish through Relay.`}});
    return {branch,head:commit.sha,pr:pr.number,url:pr.html_url};
  }
  async function check(p){
    const g=p.github;if(!g||!shaPattern.test(g.head))fail('Stage this proposal before running checks.','VALIDATION',400);
    const [ref,commit,repo]=await Promise.all([request('/git/ref/heads/'+g.branch),request('/git/commits/'+g.head),repository()]);
    if(ref.object.sha!==g.head||commit.parents.length!==1||commit.parents[0].sha!==p.base) return {state:'failure',summary:'The staged branch changed. Submit and review a new version.',head:g.head,base:p.base};
    if(repo.main!==p.base&&repo.main!==g.head)return {state:'failure',summary:'The live site changed. Update this proposal from current main.',head:g.head,base:p.base};
    const results=await request('/actions/workflows/relay-update-checks.yml/runs?head_sha='+g.head+'&event=pull_request&per_page=20',{allow404:true});
    const run=results?.workflow_runs?.filter(r=>r.head_sha===g.head&&r.head_branch===g.branch&&r.path==='.github/workflows/relay-update-checks.yml').sort((a,b)=>b.id-a.id)[0];
    if(!run)return {state:'pending',summary:'Waiting for the trusted validation workflow.',head:g.head,base:p.base};
    return {state:run.status!=='completed'?'pending':run.conclusion==='success'?'success':'failure',summary:run.status!=='completed'?'Validation is running.':run.conclusion==='success'?'Syntax and regression checks passed.':'Validation failed. Open the check report.',url:run.html_url,head:g.head,base:p.base,runId:run.id};
  }
  async function publish(p){
    const repo=await repository();
    if(repo.main===p.github.head)return {sha:p.github.head};
    if(repo.main!==p.base)fail('The live site changed. Refresh and rebase before publishing.','CONFLICT',409);
    // Non-force fast-forward is the final atomic conflict guard. Every candidate
    // has exactly one parent: the base reviewed and checked above.
    const result=await request('/git/refs/heads/main',{method:'PATCH',body:{sha:p.github.head,force:false}});
    return {sha:result.object.sha};
  }
  async function deployment(p){
    const result=await request('/actions/runs?head_sha='+p.github.head+'&per_page=30',{publicRead:true});
    const run=result.workflow_runs?.filter(r=>r.head_sha===p.github.head&&r.name==='pages build and deployment').sort((a,b)=>b.id-a.id)[0];
    return {state:!run||run.status!=='completed'?'pending':run.conclusion==='success'?'success':'failure',url:run?.html_url||'',summary:!run?'Waiting for GitHub Pages.':run.status!=='completed'?'GitHub Pages is publishing.':run.conclusion==='success'?'The website is live.':'GitHub Pages deployment failed. Check the build report.'};
  }
  async function outcome(p,main){
    if(main===p.github.head)return 'applied';
    if(main===p.base)return 'not-applied';
    const compare=await request('/compare/'+p.github.head+'...'+main,{publicRead:true});
    return ['ahead','identical'].includes(compare.status)?'superseded':'not-applied';
  }
  return {configured,repository,stage,check,publish,deployment,outcome};
}
