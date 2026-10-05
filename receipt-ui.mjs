// Read-only delivery receipt inspector. It never sends messages, pings, marks
// messages read, acknowledges events, or stores credentials/receipt payloads.
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STAGES=[['queuedAt','Queued'],['pingSentAt','Ping sent'],['serviceAcceptedAt','Service accepted'],['messageFetchedAt','Message fetched'],['agentAcknowledgedAt','Agent acknowledged']];
const LIMIT=262144;

export function receiptEndpoint(endpoint,apiBase){
  if(typeof endpoint!=='string'||!endpoint.trim()||typeof apiBase!=='string'||!apiBase)return null;
  try{
    const base=new URL(apiBase),url=new URL(endpoint,base);
    if(!['https:','http:'].includes(base.protocol)||base.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname)||
      base.username||base.password||url.origin!==base.origin||url.username||url.password||url.hash||url.search)return null;
    return url.href;
  }catch{return null;}
}
const timestamp=value=>value==null?null:typeof value==='string'&&value.length<=64&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))?value:undefined;
export function checkedReceipt(value,messageId,visibility){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.messageId?.toLowerCase()!==messageId.toLowerCase()||
    value.visibility!==visibility||!['available','no_event_record'].includes(value.receiptState)||!Array.isArray(value.recipients)||value.recipients.length>100)throw Error('Invalid receipt response');
  if(value.receiptState==='no_event_record'&&value.recipients.length)throw Error('Invalid receipt response');
  const seen=new Set();
  const recipients=value.recipients.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.recipientId!=='string'||!UUID.test(row.recipientId)||
      !(row.agentId==null||typeof row.agentId==='string'&&UUID.test(row.agentId))||!Array.isArray(row.attempts)||row.attempts.length>100)throw Error('Invalid recipient receipt');
    const id=row.recipientId.toLowerCase();if(seen.has(id))throw Error('Duplicate recipient receipt');seen.add(id);
    const result={recipientId:id,agentId:row.agentId?.toLowerCase()||null,attemptCount:row.attempts.length};
    for(const [key] of STAGES){const time=timestamp(row[key]);if(time===undefined)throw Error('Invalid receipt timestamp');result[key]=time;}
    return result;
  });
  return {messageId:messageId.toLowerCase(),visibility,receiptState:value.receiptState,recipients};
}
async function boundedJSON(response){
  if(Number(response.headers.get('Content-Length'))>LIMIT)throw Error('Receipt response too large');
  if(response.body?.getReader){
    const reader=response.body.getReader();let size=0;const chunks=[];
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>LIMIT){await reader.cancel();throw Error('Receipt response too large');}chunks.push(value);}}
    finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  const text=await response.text();if(new TextEncoder().encode(text).byteLength>LIMIT)throw Error('Receipt response too large');return JSON.parse(text);
}

export function createMessageReceipts({api,getUser,isLive,isManager=()=>getUser()?.role==='manager',getViewKey=()=>'',endpoint='',fetcher=globalThis.fetch,onSessionError=()=>{},timeoutMs=15000}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new TypeError('Receipt timeout must be between 1 and 60000 milliseconds.');
  let root=null,epoch=0;
  const jobs=new Map();
  const allowed=()=>Boolean(isLive()&&isManager()&&getUser()?.role==='manager'&&api.token);
  const configured=()=>receiptEndpoint(endpoint,api.base);
  function renderControl(messageId,visibility){
    if(!allowed())return '';
    const valid=typeof messageId==='string'&&UUID.test(messageId)&&['public','private'].includes(visibility);
    if(!valid||!configured())return '<p class="subtitle message-receipt-unavailable">Delivery receipts unavailable.</p>';
    const id=messageId.toLowerCase(),panel=`receipt-${visibility}-${id}`;
    return `<section class="message-receipts" data-receipt-message="${esc(id)}" data-receipt-visibility="${visibility}"><button type="button" class="button small" data-receipt-toggle aria-expanded="false" aria-controls="${panel}">Delivery receipts</button><div id="${panel}" data-receipt-panel role="region" aria-label="Delivery receipts" hidden></div></section>`;
  }
  function cancel(control){const job=jobs.get(control);if(job){clearTimeout(job.timer);job.controller.abort();}jobs.delete(control);}
  function collapse(control){cancel(control);const panel=control.querySelector('[data-receipt-panel]');if(panel){panel.hidden=true;panel.replaceChildren();}control.querySelector('[data-receipt-toggle]')?.setAttribute('aria-expanded','false');}
  function reset(){epoch++;for(const control of jobs.keys())cancel(control);root?.querySelectorAll('[data-receipt-message]').forEach(collapse);}
  const content=html=>`<div class="callout">${html}<p class="subtitle">Service acceptance, message fetch and agent acknowledgment are separate reports. No stage is inferred from another.</p><button type="button" class="button small" data-receipt-refresh>Refresh receipts</button></div>`;
  const renderTime=value=>value?`<time datetime="${esc(value)}">${esc(new Date(value).toISOString())}</time>`:'Not reported';
  function render(receipt){
    if(receipt.receiptState==='no_event_record')return content('<p>No event record is available for this message.</p>');
    if(!receipt.recipients.length)return content('<p>No recipient receipts are reported for this message.</p>');
    return content(receipt.recipients.map(row=>`<section><h4>Recipient ${esc(row.recipientId)}</h4><p class="subtitle">${row.agentId?`Agent ${esc(row.agentId)}`:'Agent ID not reported'} · ${row.attemptCount} recorded attempt${row.attemptCount===1?'':'s'}</p><dl>${STAGES.map(([key,label])=>`<dt>${label}</dt><dd data-receipt-stage="${key}">${renderTime(row[key])}</dd>`).join('')}</dl></section>`).join(''));
  }
  async function load(control){
    cancel(control);
    const url=configured(),messageId=control.dataset.receiptMessage,visibility=control.dataset.receiptVisibility;
    const panel=control.querySelector('[data-receipt-panel]'),button=control.querySelector('[data-receipt-toggle]');
    if(!allowed()||!url||!panel||!UUID.test(messageId||'')||!['public','private'].includes(visibility))return;
    const token=api.token,userId=getUser().id,view=getViewKey(),generation=epoch,controller=new AbortController();
    const job={controller};jobs.set(control,job);
    const current=()=>jobs.get(control)===job&&generation===epoch&&allowed()&&api.token===token&&getUser()?.id===userId&&getViewKey()===view&&root?.isConnected&&root.contains(control)&&control.isConnected&&!panel.hidden;
    panel.hidden=false;button.setAttribute('aria-expanded','true');panel.innerHTML=content('<p role="status">Loading delivery receipts…</p>');
    job.timer=setTimeout(()=>{if(current()){controller.abort();jobs.delete(control);panel.innerHTML=content('<p role="alert">Delivery receipts timed out. Try again.</p>');}},timeoutMs);
    try{
      const response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({messageId}),signal:controller.signal,
        cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
      if(!current())return;
      if(response.status===401){onSessionError();if(current())panel.innerHTML=content('<p role="alert">Your session is no longer authorized for receipts.</p>');return;}
      if(response.status===403){panel.innerHTML=content('<p role="alert">Only the studio manager can view delivery receipts.</p>');return;}
      if(!response.ok)throw Error('Receipt service unavailable');
      const receipt=checkedReceipt(await boundedJSON(response),messageId,visibility);
      if(current())panel.innerHTML=render(receipt);
    }catch(error){if(current()&&error?.name!=='AbortError')panel.innerHTML=content('<p role="alert">Delivery receipts unavailable. Try again.</p>');}
    finally{clearTimeout(job.timer);if(jobs.get(control)===job)jobs.delete(control);}
  }
  function click(event){
    const target=event.target?.closest?.('[data-receipt-toggle],[data-receipt-refresh]');
    if(!target||!root?.contains(target))return;
    // Do not let a receipt-only click trigger the inbox's mark-visible-read hook.
    event.preventDefault();event.stopPropagation();
    const control=target.closest('[data-receipt-message]');if(!control)return;
    if(!allowed()){collapse(control);return;}
    if(target.hasAttribute('data-receipt-toggle')&&target.getAttribute('aria-expanded')==='true')collapse(control);
    else load(control);
  }
  function mount(nextRoot){
    if(nextRoot!==root){reset();root?.removeEventListener('click',click);root=nextRoot;root?.addEventListener('click',click);}
    for(const control of jobs.keys())if(!root?.contains(control))cancel(control);
    if(!allowed())reset();
  }
  function destroy(){reset();root?.removeEventListener('click',click);root=null;}
  return {renderControl,mount,reset,destroy};
}
