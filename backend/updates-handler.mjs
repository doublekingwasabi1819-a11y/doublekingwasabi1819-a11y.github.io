import {createProposal,reviseProposal,reviewProposal,readiness,publicProposal} from '../updates-policy.mjs';
const fail=(message,code='VALIDATION',status=400)=>{throw Object.assign(new Error(message),{code,status});};
const actions=new Set(['updates.list','updates.submit','updates.review','updates.withdraw','updates.stage','updates.refresh','updates.publish']);
export function createUpdatesRPC({url,serviceKey,fetcher=fetch}){
  return async(action,token,data={})=>{
    let response;try{response=await fetcher(url.replace(/\/$/,'')+'/rest/v1/rpc/relay_updates_rpc',{method:'POST',headers:{'Content-Type':'application/json',apikey:serviceKey,Authorization:'Bearer '+serviceKey},body:JSON.stringify({p_action:action,p_token:token,p_data:data})});}
    catch{fail('The Update room could not be reached. Retry with the same proposal.','NETWORK',503);}
    if(!response.ok)fail('Update room storage is unavailable.','DATABASE',503);
    const r=await response.json();if(r.error)fail(r.error.message,r.error.code,r.error.status);return r;
  };
}

export function createUpdatesHandler({rpc,publisher,now=()=>Date.now(),origins=['https://doublekingwasabi1819-a11y.github.io']}){
  async function repository(){try{return await publisher.repository();}catch(e){return {main:null,connected:false,error:e.message};}}
  const repoContext=(s,repo)=>({...repo,proposals:s.proposals,activeAccountIds:s.activeAccountIds});
  function find(s,id){const p=s.proposals.find(p=>p.id===id);if(!p)fail('Update proposal not found.','NOT_FOUND',404);return p;}
  const checkDigest=(p,d)=>{if(p.digest!==d)fail('This proposal changed. Read the current version before acting.','CONFLICT',409);};
  function editable(p,user){if(user.id!==p.authorId&&user.role!=='manager')fail('Only the author or manager may change this proposal.','FORBIDDEN',403);if(['publishing','published','withdrawn'].includes(p.status))fail('This proposal is no longer editable.','CONFLICT',409);}
  async function change(token,fn){
    for(let attempt=0;attempt<4;attempt++){
      const state=await rpc('updates.load',token,{}),next=structuredClone(state.proposals);
      await fn(state,next);
      try{return await rpc('updates.commit',token,{expectedRevision:state.revision,proposals:next});}
      catch(e){if(e.code!=='CONFLICT'||attempt===3)throw e;}
    }
  }
  async function responseState(token){const state=await rpc('updates.load',token,{}),repo=await repository();return {user:state.user,repository:repo,requiredApprovals:2,proposals:state.proposals.map(p=>publicProposal(p,repoContext(state,repo)))};}
  return async request=>{
    const origin=request.headers.get('origin');const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Vary':'Origin'};
    if(origin&&origins.includes(origin))Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'POST, OPTIONS'});
    const send=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
    if(origin&&!origins.includes(origin))return send({error:{code:'ORIGIN',message:'This origin cannot use the Update room.'}},403);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    try{
      if(request.method!=='POST')fail('Use POST.','METHOD',405);
      const token=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');
      if(!request.headers.get('Authorization')?.startsWith('Bearer ')||!token||token.length>512)fail('Sign in to continue.','SESSION',401);
      if(!request.headers.get('content-type')?.startsWith('application/json'))fail('Send JSON.');
      if(Number(request.headers.get('content-length'))>1050000)fail('Proposal request is too large.','CAPACITY',413);
      const reader=request.body?.getReader();let length=0;const chunks=[];
      if(reader)while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>1050000){await reader.cancel();fail('Proposal request is too large.','CAPACITY',413);}chunks.push(value);}
      const bytes=new Uint8Array(length);let offset=0;for(const x of chunks){bytes.set(x,offset);offset+=x.length;}
      let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{fail('Invalid JSON.');}
      const {action,data={}}=body||{};if(!actions.has(action)||!data||typeof data!=='object'||Array.isArray(data))fail('Invalid Update room action.');
      if(typeof data.id==='string')data.id=data.id.toLowerCase();
      const snapshot=await rpc('updates.load',token,{}),user=snapshot.user;
      if(!user||!['manager','worker'].includes(user.role))fail('Sign in again.','SESSION',401);
      if(action==='updates.list')return send(await responseState(token));
      if(action==='updates.submit'){
        await change(token,async(s,items)=>{
          const old=items.find(p=>p.id===data.id);
          if(old){
            editable(old,s.user);
            if(data.expectedVersion===undefined){
              const duplicate=await createProposal(data,s.user,old.createdAt);
              if(old.version===1&&old.authorId===s.user.id&&duplicate.digest===old.digest)return;
              fail('This proposal ID is already used. Refresh before replacing it.','CONFLICT',409);
            }
            items[items.indexOf(old)]=await reviseProposal(old,data,s.user,new Date(now()).toISOString());
          }
          else {if(items.filter(p=>!['published','withdrawn'].includes(p.status)).length>=12)fail('Finish existing proposals before adding more.','CAPACITY',413);items.unshift(await createProposal(data,s.user,new Date(now()).toISOString()));}
        });
      }else if(action==='updates.review'){
        await change(token,(s,items)=>{const p=find(s,data.id);if(['publishing','published','withdrawn'].includes(p.status))fail('This proposal is no longer accepting reviews.','CONFLICT',409);items[items.findIndex(x=>x.id===p.id)]=reviewProposal(p,data,s.user,new Date(now()).toISOString());});
      }else if(action==='updates.withdraw'){
        await change(token,(s,items)=>{const p=find(s,data.id);editable(p,s.user);checkDigest(p,data.digest);items.find(x=>x.id===p.id).status='withdrawn';});
      }else if(action==='updates.stage'){
        const p=find(snapshot,data.id);checkDigest(p,data.digest);if(!['draft','staged'].includes(p.status))fail('This update cannot be staged.','CONFLICT',409);
        const github=await publisher.stage(p);
        await change(token,(s,items)=>{const current=find(s,p.id);checkDigest(current,p.digest);if(!['draft','staged'].includes(current.status))fail('This update changed during staging.','CONFLICT',409);Object.assign(items.find(x=>x.id===p.id),{github,status:'staged',checks:{state:'pending',head:github.head,base:p.base,summary:'Waiting for validation.'}});});
      }else if(action==='updates.refresh'){
        const p=find(snapshot,data.id);if(!p.github)return send(await responseState(token));
        const repo=await publisher.repository();
        if(p.status==='publishing'||p.status==='published'){
          const outcome=await publisher.outcome(p,repo.main);
          if(outcome!=='not-applied'||p.status==='published'){
            const deployment=outcome==='superseded'?{state:'superseded',summary:'This source update was published; a newer version is now on main.'}:await publisher.deployment(p);
            await change(token,(s,items)=>{const current=find(s,p.id);checkDigest(current,p.digest);Object.assign(items.find(x=>x.id===p.id),{deployment,...(deployment.state!=='pending'?{status:'published',publishedAt:new Date(now()).toISOString()}:{}),publishError:''});});
          }else if(now()-Date.parse(p.publishStartedAt)>120000){
            // Every provider call has a short timeout. Recover a cancelled/crashed
            // attempt after its maximum duration without assuming it succeeded.
            await change(token,(s,items)=>{const current=find(s,p.id);checkDigest(current,p.digest);if(current.publishStartedAt===p.publishStartedAt&&current.status==='publishing')Object.assign(items.find(x=>x.id===p.id),{status:'staged',publishError:'No source update was found. Review checks and retry.'});});
          }
        }else if(p.status==='staged'){
          const checks=await publisher.check(p);
          await change(token,(s,items)=>{const current=find(s,p.id);checkDigest(current,p.digest);if(current.status==='staged'&&current.github?.head===p.github.head)items.find(x=>x.id===p.id).checks=checks;});
        }
      }else if(action==='updates.publish'){
        if(user.role!=='manager')fail('Only the manager can publish the website.','FORBIDDEN',403);
        const p=find(snapshot,data.id);checkDigest(p,data.digest);
        const checks=await publisher.check(p),repo=await publisher.repository();
        let locked;
        await change(token,(s,items)=>{
          if(s.user.role!=='manager')fail('Only the manager can publish.','FORBIDDEN',403);
          const current=find(s,p.id);checkDigest(current,p.digest);
          if(s.proposals.some(x=>x.status==='publishing'))fail('Another publication is in progress.','CONFLICT',409);
          if(current.github?.head!==p.github?.head)fail('The staged commit changed.','CONFLICT',409);
          const candidate={...current,checks};const ready=readiness(candidate,repoContext(s,repo));
          if(!ready.ready)fail((ready.reasons||[]).join(' ')||'Reviews or checks are incomplete.','NOT_READY',409);
          locked={...candidate,status:'publishing',publishStartedAt:new Date(now()).toISOString(),publishError:''};items[items.findIndex(x=>x.id===p.id)]=locked;
        });
        let sourceApplied=false;
        try{
          const published=await publisher.publish(locked);
          sourceApplied=true;
          await change(token,(s,items)=>{const current=find(s,p.id);checkDigest(current,p.digest);Object.assign(items.find(x=>x.id===p.id),{publishedCommit:published.sha,deployment:{state:'pending',summary:'Source updated. Waiting for GitHub Pages.'}});});
        }catch(e){
          // An unknown provider response must never be presented as a failed push:
          // keep the lock and let Refresh reconcile the exact commit against main.
          try{await change(token,(s,items)=>{const current=find(s,p.id);checkDigest(current,p.digest);Object.assign(items.find(x=>x.id===p.id),{...(!sourceApplied&&e.code==='CONFLICT'?{status:'staged'}:{}),publishError:!sourceApplied&&e.code==='CONFLICT'?'GitHub rejected this update because the source changed. Refresh and rebase.':'Publication result needs checking. Use Refresh checks before retrying.'});});}catch{}
          throw e;
        }
      }
      return send(await responseState(token));
    }catch(e){return send({error:{code:e.code||'INTERNAL',message:e.code?e.message:'The Update room could not complete this request. Refresh and retry.'}},e.status||500);}
  };
}
