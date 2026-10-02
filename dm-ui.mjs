// DMs stay outside shared board state, exports, and browser persistence.
export function createInbox({api,getUser,isLive,toast,onSessionError}) {
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let inbox={contacts:[],threads:[],unreadCount:0},loaded=false,polling=false,selected=null,messages=[],hasMore=false,error='',generation=0;
  const drafts=new Map();
  const key=(a,b)=>[a,b].sort().join(':');
  const person=id=>id===getUser()?.id?getUser():inbox.contacts.find(c=>c.id===id);
  const label=id=>person(id)?.name||'Former worker';
  const title=t=>getUser()?.id===t.participantA?label(t.participantB):getUser()?.id===t.participantB?label(t.participantA):`${label(t.participantA)} ↔ ${label(t.participantB)}`;
  const active=()=>document.querySelector('#dm-root');
  const current=k=>isLive()&&api.token===k;
  const draftKey=()=>selected?key(selected.participantA,selected.participantB):'';
  const incoming=()=>messages.filter(m=>m.recipientId===getUser()?.id&&!m.readAt);
  const stamp=v=>new Date(v).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  function badges(){
    const n=inbox.unreadCount;
    document.querySelectorAll('[data-dm-count]').forEach(el=>{el.textContent=n>99?'99+':n;el.hidden=!n;});
    const b=document.querySelector('#dm-notification');
    if(b){b.hidden=!isLive();b.setAttribute('aria-label',n?`${n} unread private messages`:'Private messages');}
    document.title=document.title.replace(/^\(\d+\) /,'');if(n)document.title=`(${n}) ${document.title}`;
  }
  function sidebar(){return `<label class="field"><span class="field-label">Start a conversation</span><select id="dm-recipient" aria-label="Message a worker"><option value="">Choose a worker…</option>${inbox.contacts.filter(c=>c.enabled).map(c=>`<option value="${esc(c.id)}">${esc(c.name)}${c.role==='manager'?' · Manager':''}</option>`).join('')}</select></label><div class="nav-label">${getUser()?.role==='manager'?'ALL PRIVATE CONVERSATIONS':'YOUR CONVERSATIONS'}</div>${inbox.threads.map(t=>`<button class="dm-thread-button ${selected&&key(t.participantA,t.participantB)===draftKey()?'active':''}" data-dm-thread="${esc(key(t.participantA,t.participantB))}"><span class="dm-thread-title">${esc(title(t))}${t.unreadCount?`<span class="nav-badge">${t.unreadCount}</span>`:''}</span><span class="dm-preview">${esc(t.lastMessage.body.slice(0,75))}</span><time>${esc(stamp(t.lastMessage.createdAt))}</time></button>`).join('')||'<p class="subtitle">No conversations yet.</p>'}`;}
  function messagesHTML(){return `${hasMore?'<button class="button small" data-dm-action="older">Load older messages</button>':''}${messages.map(m=>`<article class="dm-bubble ${m.senderId===getUser()?.id?'mine':''}"><div class="dm-meta"><strong>${esc(label(m.senderId))}</strong><time>${esc(stamp(m.createdAt))}</time></div><p>${esc(m.body)}</p><small>${m.readAt?'Read by recipient':m.senderId===getUser()?.id?'Sent': 'Unread'}</small></article>`).join('')||'<div class="empty"><h3>Your conversation starts here</h3><p>Send a private message below.</p></div>'}`;}
  function threadHTML(){
    if(!selected)return '<div class="empty"><h3>Choose a conversation</h3><p>Select a worker to send a private message.</p></div>';
    const own=[selected.participantA,selected.participantB].includes(getUser()?.id),peer=selected.participantA===getUser()?.id?selected.participantB:selected.participantA;
    return `<div class="panel-header"><h2>${esc(title(selected))}</h2><button class="button small" data-dm-action="refresh">Refresh</button></div><div id="dm-messages" class="dm-message-list" aria-live="polite">${messagesHTML()}</div><div class="dm-read-bar"><button class="button small" data-dm-action="read" ${incoming().length?'':'hidden'}>Mark displayed messages read</button><span id="dm-thread-error" role="alert">${esc(error)}</span></div>${own?`<form id="dm-compose" class="compose"><label class="field"><span class="field-label">Private message to ${esc(label(peer))}</span><textarea name="body" aria-label="Private message" required maxlength="12000" placeholder="Write a private message…">${esc(drafts.get(draftKey())?.body||'')}</textarea></label><div class="form-error" role="alert"></div><div class="actions"><span class="checkbox-caption">Only you, ${esc(label(peer))}, and the manager can read this.</span><button class="button primary small" type="submit" ${person(peer)?.enabled===false?'disabled':''}>Send privately</button></div></form>`:'<div class="callout dm-manager-note">Manager view · Reading here does not clear either worker’s unread notification.</div>'}`;
  }
  function paint(){if(!active())return;document.querySelector('#dm-sidebar').innerHTML=sidebar();document.querySelector('#dm-thread-area').innerHTML=threadHTML();bind();}
  function paintMessages(){if(!active()||!selected)return;const list=document.querySelector('#dm-messages');if(list)list.innerHTML=messagesHTML();const read=document.querySelector('[data-dm-action="read"]');if(read)read.hidden=!incoming().length;}
  async function poll(){
    if(!isLive()||polling)return;const token=api.token,g= generation;polling=true;
    try{const next=await api.call('dm.inbox');if(!current(token)||g!==generation)return;const prior=inbox.unreadCount;inbox=next;loaded=true;error='';badges();
      if(next.unreadCount>prior)toast(`${next.unreadCount} unread private message${next.unreadCount===1?'':'s'}. Open Inbox to read.`);
      if(active()){document.querySelector('#dm-sidebar').innerHTML=sidebar();bindSidebar();if(selected)await loadThread(false);else document.querySelector('#dm-thread-area').innerHTML=threadHTML();}
    }catch(e){if(!current(token)||g!==generation)return;error=e.message;if(['SESSION','UNAUTHORIZED','STALE_SESSION','DELETED'].includes(e.code)){reset();onSessionError();return;}if(active())document.querySelector('#dm-load-error').textContent=e.message;}
    finally{if(g===generation)polling=false;}
  }
  async function loadThread(older=false){
    if(!selected)return;const token=api.token,pair={...selected},k=draftKey(),g=generation;
    const data={...pair,...(older&&messages.length?{beforeId:messages[0].id}:{})};
    const r=await api.call('dm.thread',data);if(!current(token)||g!==generation||draftKey()!==k)return;
    if(older){const seen=new Set(messages.map(m=>m.id));messages=[...r.messages.filter(m=>!seen.has(m.id)),...messages];hasMore=r.hasMore;}
    else if(messages.length>50){const old=new Map(messages.map(m=>[m.id,m]));r.messages.forEach(m=>old.set(m.id,m));messages=[...old.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));}
    else {messages=r.messages;hasMore=r.hasMore;}
    paintMessages();
  }
  async function selectThread(t){selected={participantA:t.participantA,participantB:t.participantB};messages=[];hasMore=false;error='';paint();try{await loadThread();}catch(e){error=e.message;const el=document.querySelector('#dm-thread-error');if(el)el.textContent=error;}}
  function bindSidebar(){
    const select=document.querySelector('#dm-recipient');if(select)select.onchange=()=>{if(select.value)selectThread({participantA:getUser().id,participantB:select.value});};
    document.querySelectorAll('[data-dm-thread]').forEach(b=>b.onclick=()=>{const t=inbox.threads.find(t=>key(t.participantA,t.participantB)===b.dataset.dmThread);if(t)selectThread(t);});
  }
  function bind(){
    bindSidebar();const root=active();if(!root)return;
    root.onclick=async e=>{const button=e.target.closest('[data-dm-action]');if(!button)return;const action=button.dataset.dmAction;button.disabled=true;try{
      if(action==='refresh'){await poll();await loadThread();}
      if(action==='older')await loadThread(true);
      if(action==='read'){const ids=incoming().map(m=>m.id).slice(-100),token=api.token,g=generation;await api.call('dm.read',{messageIds:ids});if(!current(token)||g!==generation)return;messages=messages.map(m=>ids.includes(m.id)?{...m,readAt:new Date().toISOString()}:m);paintMessages();await poll();toast('Displayed messages marked read');}
    }catch(e){const el=document.querySelector('#dm-thread-error');if(el)el.textContent=e.message;}finally{button.disabled=false;}};
    const form=document.querySelector('#dm-compose');if(!form)return;
    form.elements.body.oninput=e=>{const d=drafts.get(draftKey());drafts.set(draftKey(),{body:e.target.value,clientId:d?.body===e.target.value?d.clientId:crypto.randomUUID()});};
    form.onsubmit=async e=>{e.preventDefault();const token=api.token,g=generation,k=draftKey(),body=form.elements.body.value,recipientId=selected.participantA===getUser().id?selected.participantB:selected.participantA;
      const d=drafts.get(k)||{body,clientId:crypto.randomUUID()};drafts.set(k,d);const b=form.querySelector('[type="submit"]');b.disabled=true;form.querySelector('.form-error').textContent='';
      try{await api.call('dm.send',{recipientId,body,clientId:d.clientId});if(!current(token)||g!==generation)return;if(drafts.get(k)?.body===body){drafts.delete(k);if(draftKey()===k&&form.isConnected)form.elements.body.value='';}await poll();toast('Private message sent');}
      catch(err){if(current(token)&&g===generation&&form.isConnected)form.querySelector('.form-error').textContent=err.message+' Your draft is still here.';}finally{b.disabled=false;}
    };
  }
  function render(){return `<div class="page-title"><div><div class="eyebrow">CODERCODE / STUDIO</div><h1>Private inbox</h1><p class="subtitle">${getUser()?.role==='manager'?'You can read every private conversation in your studio.':'Private conversations with your workers and manager.'}</p></div></div><div class="callout dm-privacy">Only the two participants and the studio manager can read a conversation. Unread alerts update while Relay is open.</div>${!isLive()?'<div class="empty"><h3>Sign in to use private messages</h3><p>Private inboxes are available for real worker and manager accounts.</p></div>':`<section id="dm-root" class="panel dm-layout"><aside id="dm-sidebar" class="dm-sidebar">${loaded?sidebar():'<p>Loading your inbox…</p>'}</aside><div id="dm-thread-area">${threadHTML()}</div></section><p id="dm-load-error" class="form-error" role="alert">${esc(error)}</p>`}`;}
  function mount(){badges();if(!isLive())return;bind();if(!loaded)poll();}
  function reset(){generation++;inbox={contacts:[],threads:[],unreadCount:0};selected=null;messages=[];hasMore=false;loaded=false;polling=false;error='';drafts.clear();badges();}
  setInterval(()=>{if(!document.hidden)poll();},10000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
  return {render,mount,reset,poll};
}

// Extends Relay's existing example board. No network calls or real account data.
export function createDemoInboxAPI(getUser,getAgents){
  let rows=[],initialized=false;
  return {token:'example-inbox',async call(action,d={}){
    const accounts=[{id:'owner',name:'Example manager',role:'manager',enabled:true},...getAgents().map(a=>({id:a.id,name:a.name,role:'worker',enabled:a.enabled}))],user=getUser();
    if(!initialized&&accounts.length>2){rows=[{id:crypto.randomUUID(),senderId:accounts[2].id,recipientId:accounts[1].id,body:'Example: The movement review is ready. Can you check the turning test?',createdAt:new Date().toISOString(),readAt:null}];initialized=true;}
    const visible=rows.filter(m=>user.role==='manager'||[m.senderId,m.recipientId].includes(user.id));
    if(action==='dm.inbox'){
      const groups=new Map();for(const m of visible){const ids=[m.senderId,m.recipientId].sort(),k=ids.join(':');if(!groups.has(k))groups.set(k,{participantA:ids[0],participantB:ids[1],unreadCount:0});const t=groups.get(k);t.lastMessage=m;if(m.recipientId===user.id&&!m.readAt)t.unreadCount++;}
      return{contacts:accounts.filter(a=>a.id!==user.id),threads:[...groups.values()].reverse(),unreadCount:visible.filter(m=>m.recipientId===user.id&&!m.readAt).length};
    }
    if(action==='dm.thread')return{messages:visible.filter(m=>[d.participantA,d.participantB].includes(m.senderId)&&[d.participantA,d.participantB].includes(m.recipientId)),hasMore:false};
    if(action==='dm.send'){const m={id:crypto.randomUUID(),senderId:user.id,recipientId:d.recipientId,body:d.body,createdAt:new Date().toISOString(),readAt:null};rows.push(m);return{message:m};}
    if(action==='dm.read'){rows.forEach(m=>{if(m.recipientId===user.id&&d.messageIds.includes(m.id))m.readAt=new Date().toISOString();});return{ok:true};}
  }};
}
