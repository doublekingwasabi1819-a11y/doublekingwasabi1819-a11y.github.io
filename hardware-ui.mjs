// Shared hardware is authoritative server state, never a browser-local queue.
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STATES=new Set(['queued','running','completed','failed','cancelled']);
export const HEARTBEAT_TTL=90000;
export function hardwareState(snapshot,now=Date.now()){
  if(!snapshot)return {key:'unconfigured',label:'Not connected',detail:'Shared compute is not configured. A server-side queue and a verified hardware worker are needed.'};
  if(snapshot.version!==1||typeof snapshot.configured!=='boolean'||!Array.isArray(snapshot.jobs)||snapshot.jobs.length>100||snapshot.jobs.some(j=>!j||typeof j.id!=='string'||typeof j.title!=='string'||typeof j.agentName!=='string'||!STATES.has(j.status)))throw new Error('Hardware returned an unsupported response.');
  if(!snapshot.configured)return hardwareState(null,now);
  if(!snapshot.queue||typeof snapshot.queue.canSubmit!=='boolean'||!Array.isArray(snapshot.queue.operations)||snapshot.queue.operations.length>10||snapshot.queue.operations.some(op=>typeof op!=='string'))throw new Error('Hardware returned an unsupported queue response.');
  const device=snapshot.device;
  if(!device||!['offline','ready','busy','error'].includes(device.state))return {key:'disconnected',label:'Not connected',detail:'No verified hardware worker is connected.'};
  const heartbeat=Date.parse(device.lastSeenAt),age=now-heartbeat;
  if(!Number.isFinite(heartbeat)||age< -5000||age>HEARTBEAT_TTL||device.state==='offline')return {key:'disconnected',label:'Not connected',detail:'The hardware worker is offline or its heartbeat has expired.'};
  if(device.state==='error')return {key:'error',label:'Needs attention',detail:'The hardware worker reported an error. New calculations are paused.'};
  return {key:device.state,label:device.state==='busy'?'Connected · Busy':'Connected · Ready',detail:device.state==='busy'?'The shared machine is working. New jobs wait their turn.':'The shared machine is available for calculations.'};
}
export function calculationValues(text){
  const pieces=text.trim().split(/[\s,]+/);
  if(!text.trim()||pieces.length>1000)throw new Error('Enter between 1 and 1,000 numbers, separated by spaces or commas.');
  if(pieces.some(v=>! /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v)))throw new Error('Use numbers only, separated by spaces or commas.');
  const values=pieces.map(Number);
  if(values.some(v=>!Number.isFinite(v)||Math.abs(v)>1e12))throw new Error('Each number must be finite and between −1 trillion and 1 trillion.');
  return values;
}
export function createHardware({api,getUser,isLive,onSessionError=()=>{},now=Date.now,uuid=()=>crypto.randomUUID(),getRoot=()=>document.querySelector('#hardware-root'),timeoutMs=15000}){
  let snapshot=null,loaded=false,loading=false,sending=false,error='',notice='',generation=0,lastRead=0;
  let draft={title:'',numbers:''},attempt=null;
  const live=()=>Boolean(isLive()&&getUser()?.id);
  const context=()=>({generation,token:api.token,user:getUser()?.id});
  const current=c=>c.generation===generation&&c.token===api.token&&c.user===getUser()?.id&&live();
  async function request(action,data){let timer;try{return await Promise.race([api.call(action,data),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Hardware request timed out')),timeoutMs);})]);}finally{clearTimeout(timer);}}
  function status(){if(!live())return {key:'unconfigured',label:'Not connected',detail:'Example view only. Sign in to check shared hardware.'};if(error)return {key:'error',label:'Status unavailable',detail:error};if(!loaded)return {key:'checking',label:'Not connected · Checking',detail:'Waiting for verified hardware status.'};return hardwareState(snapshot,now());}
  function allowed(){const s=status();return !loading&&!sending&&['ready','busy'].includes(s.key)&&snapshot?.queue?.canSubmit===true&&snapshot.queue.operations?.includes('numbers.summary');}
  function markup(){
    const s=status(),jobs=snapshot?.jobs||[],enabled=allowed();
    return `<div class="hardware-layout"><section class="panel hardware-device" aria-labelledby="hardware-device-title"><div class="panel-body"><div class="eyebrow">SHARED COMPUTE</div><h2 id="hardware-device-title">Vast.ai hardware</h2><p class="subtitle">One machine. A shared line for your agents, like a school printer.</p><button type="button" class="button hardware-status ${s.key}" data-hardware="refresh" ${loading?'disabled':''} aria-describedby="hardware-status-detail"><span class="hardware-light" aria-hidden="true"></span>${h(s.label)} <span aria-hidden="true">↻</span></button><p id="hardware-status-detail" role="status">${h(s.detail)}</p>${snapshot?.device?.name?`<p class="subtitle">Device: ${h(snapshot.device.name)}</p>`:''}<p class="subtitle">${lastRead?'Last checked: '+h(new Date(lastRead).toLocaleTimeString()):'No verified connection yet.'} Click the status button to check again.</p><div class="callout">Connecting hardware requires separate setup. This page does not rent a machine or start a Vast.ai instance.</div></div></section>
    <section class="panel"><div class="panel-header"><h2>Request a calculation</h2></div><div class="panel-body"><p class="subtitle">Agents submit a job, wait their turn, then collect the result. Jobs are shared through Relay’s backend.</p><form id="hardware-form"><label class="field"><span class="field-label">Job name</span><input name="title" maxlength="120" value="${h(draft.title)}" placeholder="For example: summarize test timings" ${sending?'disabled':''}></label><label class="field"><span class="field-label">Numbers to summarize</span><textarea name="numbers" maxlength="24000" placeholder="12, 18, 24" ${sending?'disabled':''}>${h(draft.numbers)}</textarea><small>Sum, average, minimum and maximum. Numbers only; no scripts or credentials.</small></label><p id="hardware-submit-help" class="subtitle">${enabled?'Your signed-in agent identity is attached by the server.':sending?'Waiting for the server to acknowledge this job.':'Requests are disabled until verified hardware and the shared queue are available.'}</p><button class="button primary" type="submit" aria-describedby="hardware-submit-help" ${enabled?'':'disabled'}>${sending?'Submitting…':attempt?'Retry calculation request':'Queue calculation'}</button><p class="hardware-feedback" role="status">${h(notice)}</p></form></div></section>
    <section class="panel hardware-queue"><div class="panel-header"><h2>Shared job queue</h2><span class="badge">${loaded&&!error&&snapshot?.configured?'Server-backed':'Awaiting setup'}</span></div><div class="panel-body">${error?'<p>Queue unavailable. Check the connection before relying on earlier job information.</p>':!snapshot?.configured?'<div class="empty"><h3>No shared queue connected</h3><p>No jobs are saved locally or sent to hardware. When connected, agent names, job status and results will appear here.</p></div>':!jobs.length?'<div class="empty"><h3>No jobs in the queue</h3><p>Calculations will appear here after the server accepts them.</p></div>':`<ol class="hardware-jobs">${jobs.map(j=>`<li><div><strong>${h(j.title)}</strong><p class="subtitle">${h(j.agentName)} · ${h(j.id)}</p></div><span class="badge ${j.status==='completed'?'done':j.status==='running'?'working':j.status==='failed'?'blocked':''}">${h(j.status)}</span>${j.status==='completed'&&j.result?`<pre class="hardware-result">${h(typeof j.result==='string'?j.result:JSON.stringify(j.result,null,2))}</pre>`:''}${j.status==='failed'?'<p>Calculation failed. No successful result is available.</p>':''}</li>`).join('')}</ol>`}</div></section></div>`;
  }
  function paint(){const root=getRoot();if(!root)return;const active=root.ownerDocument?.activeElement;const field=active?.closest?.('#hardware-form')?active.name:null;const control=active?.matches?.('[data-hardware="refresh"]')?'[data-hardware="refresh"]':active?.closest?.('#hardware-form')&&active?.type==='submit'?'[type="submit"]':null;const start=active?.selectionStart,end=active?.selectionEnd;root.innerHTML=markup();mount(false);if(field){const input=root.querySelector(`[name="${field}"]`);input?.focus();if(typeof start==='number')input?.setSelectionRange(start,end);}else if(control)root.querySelector(control)?.focus();}
  function handleError(e,c){if(!current(c))return;if(['SESSION','UNAUTHORIZED','STALE_SESSION','DELETED'].includes(e.code)){reset();onSessionError();return;}error='Could not verify hardware status. Check the connection and try again.';snapshot=null;}
  async function poll(force=false){
    if(!live()||loading||sending||!force&&loaded&&now()-lastRead<30000)return;
    const c=context();loading=true;paint();
    try{const data=await request('hardware.read');if(!current(c))return;hardwareState(data,now());snapshot=data;loaded=true;error='';lastRead=now();}
    catch(e){if(!current(c))return;if(e.code==='NOT_FOUND'||e.code==='NOT_CONFIGURED'){snapshot=null;loaded=true;error='';lastRead=now();}else handleError(e,c);}
    finally{if(current(c)){loading=false;paint();}}
  }
  async function submit(){
    if(!allowed())return;
    let payload;
    try{if(!draft.title.trim())throw new Error('Give this calculation a job name.');payload={title:draft.title.trim(),operation:'numbers.summary',values:calculationValues(draft.numbers)};}catch(e){notice=e.message;paint();return;}
    const key=JSON.stringify(payload);if(!attempt||attempt.key!==key)attempt={key,id:uuid()};
    const c=context();sending=true;notice='';paint();
    try{const response=await request('hardware.enqueue',{...payload,clientId:attempt.id});if(!current(c))return;if(!response?.job||typeof response.job.id!=='string'||!STATES.has(response.job.status))throw new Error('Unconfirmed response');notice=`Job ${response.job.id} accepted by the shared queue. Status: ${response.job.status}.`;draft={title:'',numbers:''};attempt=null;}
    catch(e){if(!current(c))return;if(['SESSION','UNAUTHORIZED','STALE_SESSION','DELETED'].includes(e.code)){handleError(e,c);return;}notice='Submission was not confirmed. Check the shared queue, then retry the same request if needed. Retrying the same request uses the same ID.';}
    finally{if(current(c)){sending=false;paint();await poll(true);}}
  }
  function mount(check=true){const root=getRoot();if(!root)return;root.querySelector('[data-hardware="refresh"]').onclick=()=>poll(true);const form=root.querySelector('form');form.oninput=()=>{draft={title:form.elements.title.value,numbers:form.elements.numbers.value};};form.onsubmit=e=>{e.preventDefault();submit();};if(check)poll();}
  function reset(){generation++;snapshot=null;loaded=false;loading=false;sending=false;error='';notice='';lastRead=0;draft={title:'',numbers:''};attempt=null;}
  return {render:()=>`<div id="hardware-root">${markup()}</div>`,mount,poll,reset,submit};
}
