// DMs stay outside shared board state, exports, and browser persistence.
export function createInbox({api,getUser,isLive,toast,onSessionError}) {
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let inbox={contacts:[],threads:[],unreadCount:0},loaded=false,polling=false,selected=null,messages=[],hasMore=false,error='',generation=0;
  const drafts=new Map(),scrollPositions=new Map(),confirmedReads=new Map();
  let readTimer,reading=null,readRevision=0,pollAgain=false;
  const readError='Could not mark messages read. Use Refresh to retry.';
  const paintedHTML=new WeakMap(),pendingOptions=new WeakMap();
  const key=(a,b)=>[a,b].sort().join(':');
  const person=id=>id===getUser()?.id?getUser():inbox.contacts.find(c=>c.id===id);
  const label=id=>person(id)?.name||'Former worker';
  const initials=name=>name.trim().split(/\s+/).slice(0,2).map(part=>Array.from(part)[0]||'').join('').toUpperCase();
  const title=t=>getUser()?.id===t.participantA?label(t.participantB):getUser()?.id===t.participantB?label(t.participantA):`${label(t.participantA)} ↔ ${label(t.participantB)}`;
  const active=()=>document.querySelector('#dm-root');
  const current=k=>isLive()&&api.token===k;
  const draftKey=()=>selected?key(selected.participantA,selected.participantB):'';
  const incoming=()=>messages.filter(m=>m.recipientId===getUser()?.id&&!m.readAt);
  const stamp=v=>new Date(v).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  const nodeKey=node=>node.dataset.dmThread?`thread:${node.dataset.dmThread}`:node.dataset.dmMessage?`message:${node.dataset.dmMessage}`:node.dataset.dmAction?`action:${node.dataset.dmAction}`:node.querySelector('#dm-recipient')?'recipient':`${node.tagName}:${node.className}`;
  function applyOptions(select,html){
    const value=select.value;select.innerHTML=html;
    select.value=Array.from(select.options).some(option=>option.value===value)?value:'';
  }
  function updateNode(node,next){
    const select=node.querySelector('#dm-recipient'),nextSelect=next.querySelector('#dm-recipient');
    if(select&&nextSelect){
      const html=nextSelect.innerHTML;
      if(select.innerHTML===html){pendingOptions.delete(select);return;}
      // Keep the native select and its options untouched while its picker may be open.
      if(document.activeElement===select){
        pendingOptions.set(select,html);
        select.onblur=()=>{const pending=pendingOptions.get(select);pendingOptions.delete(select);if(pending!==undefined&&select.isConnected)applyOptions(select,pending);};
      }else{pendingOptions.delete(select);applyOptions(select,html);}
      return;
    }
    // Reuse buttons so listeners, transient disabled state, and focus survive updates.
    if(node.className!==next.className)node.className=next.className;
    for(const attribute of ['aria-current']){if(next.hasAttribute(attribute))node.setAttribute(attribute,next.getAttribute(attribute));else node.removeAttribute(attribute);}
    if(node.innerHTML!==next.innerHTML)node.innerHTML=next.innerHTML;
  }
  function patchChildren(target,html){
    if(!target||paintedHTML.get(target)===html)return;
    const template=document.createElement('template');template.innerHTML=html;
    const focused=document.activeElement,hadFocus=target.contains(focused);
    const previous=Array.from(target.children),byKey=new Map(previous.map(node=>[nodeKey(node),node])),kept=new Set();
    let cursor=target.firstElementChild;
    for(const next of Array.from(template.content.children)){
      const node=byKey.get(nodeKey(next))||next;
      if(node!==next)updateNode(node,next);
      if(node!==cursor)target.insertBefore(node,cursor);
      kept.add(node);cursor=node.nextElementSibling;
    }
    for(const node of previous)if(!kept.has(node))node.remove();
    paintedHTML.set(target,html);
    if(hadFocus&&document.activeElement!==focused){
      if(focused.isConnected)focused.focus({preventScroll:true});
      else{target.tabIndex=-1;target.focus({preventScroll:true});}
    }
  }
  function paintSidebar(){patchChildren(document.querySelector('#dm-sidebar'),sidebar());bindSidebar();}
  function visibleIncomingIds(){
    const list=active()?.querySelector('#dm-messages');
    if(!isLive()||document.hidden||!selected||!list?.isConnected||document.querySelector('#modal')?.open||document.querySelector('.sidebar.open'))return [];
    // The phone keyboard/pinch zoom can shrink the visible viewport without
    // changing innerHeight. Don't acknowledge messages behind that keyboard.
    const viewport=window.visualViewport,viewportTop=viewport?.offsetTop||0,viewportLeft=viewport?.offsetLeft||0;
    const header=document.querySelector('.topbar'),headerBox=header?.getBoundingClientRect(),position=header?getComputedStyle(header).position:'';
    const coveredTop=headerBox&&['fixed','sticky'].includes(position)&&headerBox.top<=viewportTop?headerBox.bottom:viewportTop;
    const box=list.getBoundingClientRect(),top=Math.max(viewportTop,coveredTop,box.top),bottom=Math.min(viewportTop+(viewport?.height??innerHeight),box.bottom),left=Math.max(viewportLeft,box.left),right=Math.min(viewportLeft+(viewport?.width??innerWidth),box.right);
    if(bottom<=top||right<=left||!list.getClientRects().length)return [];
    const nodes=new Map(Array.from(list.querySelectorAll('[data-dm-message]'),node=>[node.dataset.dmMessage,node]));
    return incoming().filter(message=>{
      const node=nodes.get(message.id);if(!node?.getClientRects().length)return false;
      const rect=node.getBoundingClientRect();
      return rect.bottom>top&&rect.top<bottom&&rect.right>left&&rect.left<right;
    }).map(message=>message.id).slice(-100);
  }
  function scheduleRead(){
    clearTimeout(readTimer);
    if(!isLive()||document.hidden||!active())return;
    const token=api.token,g=generation,k=draftKey(),list=document.querySelector('#dm-messages');
    readTimer=setTimeout(()=>{
      if(!current(token)||g!==generation||k!==draftKey()||list!==document.querySelector('#dm-messages')||reading)return;
      const ids=visibleIncomingIds();if(ids.length)markMessagesRead(ids).catch(()=>{});
    },250);
  }
  async function markMessagesRead(messageIds){
    const token=api.token,g=generation,k=draftKey(),userId=getUser()?.id;
    if(reading){await reading.promise.catch(()=>{});if(!current(token)||g!==generation||k!==draftKey())return;}
    const ids=[...new Set(messageIds)].filter(id=>!confirmedReads.has(id)).slice(-100);
    if(!ids.length||!current(token)||!userId)return;
    const job={token,g,k,promise:null};let succeeded=false;
    job.promise=(async()=>{
      try{
        const result=await api.call('dm.read',{messageIds:ids});
        if(!current(token)||g!==generation||getUser()?.id!==userId)return;
        const readAt=new Date().toISOString();ids.forEach(id=>confirmedReads.set(id,readAt));readRevision++;
        inbox.unreadCount=Number.isSafeInteger(result?.unreadCount)&&result.unreadCount>=0?result.unreadCount:Math.max(0,inbox.unreadCount-ids.length);
        inbox.threads=inbox.threads.map(thread=>key(thread.participantA,thread.participantB)===k?{...thread,unreadCount:Math.max(0,thread.unreadCount-ids.length)}:thread);
        if(draftKey()===k){messages=messages.map(message=>confirmedReads.has(message.id)?{...message,readAt:confirmedReads.get(message.id)}:message);paintMessages();const node=document.querySelector('#dm-thread-error');if(node?.textContent===readError)node.textContent='';}
        badges();if(active())paintSidebar();succeeded=true;
        if(polling)pollAgain=true;else poll();
      }catch(err){
        if(g!==generation||getUser()?.id!==userId)return;
        if(['SESSION','UNAUTHORIZED','STALE_SESSION','DELETED'].includes(err.code)&&(!api.token||api.token===token)){reset();onSessionError();return;}
        if(!current(token))return;
        if(draftKey()===k){const node=document.querySelector('#dm-thread-error');if(node)node.textContent=readError;}
        throw err;
      }finally{if(reading===job){reading=null;if(succeeded)scheduleRead();}}
    })();
    reading=job;return job.promise;
  }
  function badges(){
    const n=inbox.unreadCount;
    document.querySelectorAll('[data-dm-count]').forEach(el=>{el.textContent=n>99?'99+':n;el.hidden=!n;});
    const b=document.querySelector('#dm-notification');
    if(b){b.hidden=!isLive();b.setAttribute('aria-label',n?`${n} unread private messages`:'Private messages');}
    document.title=document.title.replace(/^\(\d+\) /,'');if(n)document.title=`(${n}) ${document.title}`;
  }
  function sidebar(){return `<label class="field"><span class="field-label">Start a conversation</span><select id="dm-recipient" aria-label="Message a worker"><option value="">Choose a worker…</option>${inbox.contacts.filter(c=>c.enabled).map(c=>`<option value="${esc(c.id)}">${esc(c.name)}${c.role==='manager'?' · Manager':''}</option>`).join('')}</select></label><div class="nav-label">${getUser()?.role==='manager'?'ALL PRIVATE CONVERSATIONS':'YOUR CONVERSATIONS'}</div>${inbox.threads.map(t=>`<button class="dm-thread-button ${selected&&key(t.participantA,t.participantB)===draftKey()?'active':''}" aria-current="${selected&&key(t.participantA,t.participantB)===draftKey()?'true':'false'}" data-dm-thread="${esc(key(t.participantA,t.participantB))}"><span class="dm-thread-avatar" aria-hidden="true">${esc(initials(title(t)))}</span><span class="dm-thread-copy"><span class="dm-thread-title">${esc(title(t))}${t.unreadCount?`<span class="nav-badge">${t.unreadCount}</span>`:''}</span><span class="dm-preview">${esc(t.lastMessage.body.slice(0,75))}</span><time>${esc(stamp(t.lastMessage.createdAt))}</time></span></button>`).join('')||'<p class="subtitle">No conversations yet.</p>'}`;}
  function messagesHTML(){return `${hasMore?'<button class="button small" data-dm-action="older">Load older messages</button>':''}${messages.map(m=>`<article data-dm-message="${esc(m.id)}" class="dm-bubble ${m.senderId===getUser()?.id?'mine':''}"><div class="dm-meta"><strong>${esc(label(m.senderId))}</strong><time>${esc(stamp(m.createdAt))}</time></div><p>${esc(m.body)}</p><small>${m.readAt?'Read by recipient':m.senderId===getUser()?.id?'Sent': 'Unread'}</small></article>`).join('')||'<div class="empty"><h3>Your conversation starts here</h3><p>Send a private message below.</p></div>'}`;}
  function threadHTML(){
    if(!selected)return '<div class="empty dm-empty"><span class="dm-empty-icon" aria-hidden="true">↗</span><h3>A little space to work together.</h3><p>Choose a teammate or an existing conversation. Your messages stay between the participants and your manager.</p></div>';
    const own=[selected.participantA,selected.participantB].includes(getUser()?.id),peer=selected.participantA===getUser()?.id?selected.participantB:selected.participantA;
    return `<div class="panel-header"><div class="dm-conversation-heading"><span class="dm-header-avatar" aria-hidden="true">${esc(initials(title(selected)))}</span><div><h2>${esc(title(selected))}</h2><p>${own?'Private conversation':'Manager view'}</p></div></div><div class="dm-header-actions"><button class="button small" data-dm-action="latest" aria-label="Jump to latest message">Latest ↓</button><button class="button small" data-dm-action="refresh">Refresh</button></div></div><div id="dm-messages" class="dm-message-list" role="region" aria-label="Conversation messages" tabindex="0"> ${messagesHTML()}</div><div class="dm-read-bar"><button class="button small" data-dm-action="read" ${incoming().length?'':'hidden'}>Mark displayed messages read</button><span id="dm-thread-error" role="alert">${esc(error)}</span></div>${own?`<form id="dm-compose" class="compose"><label class="field"><span class="field-label">Private message to ${esc(label(peer))}</span><textarea name="body" aria-label="Private message" required maxlength="12000" placeholder="Write a private message…">${esc(drafts.get(draftKey())?.body||'')}</textarea></label><div class="form-error" role="alert"></div><div class="actions"><span class="checkbox-caption">Only you, ${esc(label(peer))}, and the manager can read this.</span><button class="button primary small" type="submit" ${person(peer)?.enabled===false?'disabled':''}>Send privately</button></div></form>`:'<div class="callout dm-manager-note">Manager view · Reading here does not clear either worker’s unread notification.</div>'}`;
  }
  function paint(){
    if(!active())return;paintSidebar();
    const select=document.querySelector('#dm-recipient'),userId=getUser()?.id;
    if(select)select.value=selected?.participantA===userId?selected.participantB:selected?.participantB===userId?selected.participantA:'';
    document.querySelector('#dm-thread-area').innerHTML=threadHTML();bind();
  }
  function paintMessages(){if(!active()||!selected)return;patchChildren(document.querySelector('#dm-messages'),messagesHTML());const read=document.querySelector('[data-dm-action="read"]');if(read)read.hidden=!incoming().length;}
  async function poll(){
    if(!isLive()||polling)return;const token=api.token,g=generation,revision=readRevision,userId=getUser()?.id;polling=true;
    try{const next=await api.call('dm.inbox');if(!current(token)||g!==generation)return;if(revision!==readRevision){pollAgain=true;return;}const prior=inbox.unreadCount;inbox=next;loaded=true;error='';badges();
      if(next.unreadCount>prior)toast(`${next.unreadCount} unread private message${next.unreadCount===1?'':'s'}. Open Inbox to read.`);
      if(active()){paintSidebar();if(selected)await loadThread(false);else patchChildren(document.querySelector('#dm-thread-area'),threadHTML());}
    }catch(e){if(g!==generation||getUser()?.id!==userId)return;if(['SESSION','UNAUTHORIZED','STALE_SESSION','DELETED'].includes(e.code)&&(!api.token||api.token===token)){reset();onSessionError();return;}if(!current(token))return;error=e.message;if(active())document.querySelector('#dm-load-error').textContent=e.message;}
    finally{if(g===generation){polling=false;if(pollAgain){pollAgain=false;poll();}}}
  }
  function rememberScroll(list,k=draftKey()){if(list&&k)scrollPositions.set(k,{top:list.scrollTop,bottom:list.scrollHeight-list.scrollTop-list.clientHeight<64});}
  function scrollLatest(){const list=document.querySelector('#dm-messages');if(list){list.scrollTop=list.scrollHeight;rememberScroll(list);}}
  function restoreScroll(){const list=document.querySelector('#dm-messages'),saved=scrollPositions.get(draftKey());if(!list)return;if(saved&&!saved.bottom){list.scrollTop=saved.top;rememberScroll(list);}else scrollLatest();}
  async function loadThread(older=false,initial=false){
    if(!selected)return;const token=api.token,pair={...selected},k=draftKey(),g=generation;
    const list=document.querySelector('#dm-messages');
    const data={...pair,...(older&&messages.length?{beforeId:messages[0].id}:{})};
    const r=await api.call('dm.thread',data);if(!current(token)||g!==generation||draftKey()!==k)return;
    const previousHeight=list?.scrollHeight||0,previousTop=list?.scrollTop||0;
    const atBottom=list&&list.scrollHeight-list.scrollTop-list.clientHeight<64;
    if(older){const seen=new Set(messages.map(m=>m.id));messages=[...r.messages.filter(m=>!seen.has(m.id)),...messages];hasMore=r.hasMore;}
    else if(messages.length>50){const old=new Map(messages.map(m=>[m.id,m]));r.messages.forEach(m=>old.set(m.id,m));messages=[...old.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));}
    else {messages=r.messages;hasMore=r.hasMore;}
    messages=messages.map(message=>confirmedReads.has(message.id)?{...message,readAt:confirmedReads.get(message.id)}:message);
    paintMessages();
    if(list?.isConnected){if(older)list.scrollTop=previousTop+list.scrollHeight-previousHeight;else if(initial||atBottom)scrollLatest();rememberScroll(list,k);}
    scheduleRead();
  }
  async function selectThread(t){selected={participantA:t.participantA,participantB:t.participantB};messages=[];hasMore=false;error='';paint();try{await loadThread(false,true);}catch(e){error=e.message;const el=document.querySelector('#dm-thread-error');if(el)el.textContent=error;}}
  function bindSidebar(){
    const select=document.querySelector('#dm-recipient');if(select)select.onchange=()=>{if(select.value)selectThread({participantA:getUser().id,participantB:select.value});};
    document.querySelectorAll('[data-dm-thread]').forEach(b=>b.onclick=()=>{const t=inbox.threads.find(t=>key(t.participantA,t.participantB)===b.dataset.dmThread);if(t)selectThread(t);});
  }
  function bind(){
    bindSidebar();const root=active();if(!root)return;
    const list=root.querySelector('#dm-messages'),scrollKey=draftKey();if(list)list.onscroll=()=>{rememberScroll(list,scrollKey);scheduleRead();};
    root.onclick=async e=>{const button=e.target.closest('[data-dm-action]');if(!button)return;const action=button.dataset.dmAction,hadFocus=document.activeElement===button,focusToken=api.token,focusGeneration=generation,focusThread=draftKey();button.disabled=true;try{
      if(action==='latest')scrollLatest();
      if(action==='refresh'){await poll();await loadThread();}
      if(action==='older')await loadThread(true);
      if(action==='read'){await markMessagesRead(incoming().map(m=>m.id));if(current(focusToken)&&focusGeneration===generation&&focusThread===draftKey())toast('Displayed messages marked read');}
    }catch(e){const el=document.querySelector('#dm-thread-error');if(el)el.textContent=e.message;}finally{
      button.disabled=false;
      if(hadFocus&&current(focusToken)&&focusGeneration===generation&&focusThread===draftKey()&&(document.activeElement===document.body||document.activeElement===button)){
        if(button.isConnected&&!button.hidden)button.focus({preventScroll:true});
        else if(action==='read'&&root.isConnected){const target=root.querySelector('#dm-compose textarea')||root.querySelector('#dm-messages');target?.focus({preventScroll:true});}
        else if(action==='older'&&root.isConnected){const list=root.querySelector('#dm-messages');if(list){list.tabIndex=-1;list.focus({preventScroll:true});}}
      }
    }};
    const form=document.querySelector('#dm-compose');if(!form)return;
    form.elements.body.oninput=e=>{const d=drafts.get(draftKey());drafts.set(draftKey(),{body:e.target.value,clientId:d?.body===e.target.value?d.clientId:crypto.randomUUID()});};
    form.onsubmit=async e=>{e.preventDefault();const token=api.token,g=generation,k=draftKey(),body=form.elements.body.value,recipientId=selected.participantA===getUser().id?selected.participantB:selected.participantA;
      const d=drafts.get(k)||{body,clientId:crypto.randomUUID()};drafts.set(k,d);const b=form.querySelector('[type="submit"]');b.disabled=true;form.querySelector('.form-error').textContent='';
      try{await api.call('dm.send',{recipientId,body,clientId:d.clientId});if(!current(token)||g!==generation)return;if(drafts.get(k)?.body===body){drafts.delete(k);if(draftKey()===k&&form.isConnected)form.elements.body.value='';}await poll();if(current(token)&&g===generation&&draftKey()===k)scrollLatest();toast('Private message sent');}
      catch(err){if(current(token)&&g===generation&&form.isConnected)form.querySelector('.form-error').textContent=err.message+' Your draft is still here.';}finally{b.disabled=false;}
    };
  }
  function render(){return `<div class="page-title"><div><div class="eyebrow">CODERCODE / STUDIO</div><h1>Private inbox</h1><p class="subtitle">${getUser()?.role==='manager'?'You can read every private conversation in your studio.':'Private conversations with your workers and manager.'}</p></div></div><div class="callout dm-privacy">Only the two participants and the studio manager can read a conversation. Unread alerts update while Relay is open.</div>${!isLive()?'<div class="empty"><h3>Sign in to use private messages</h3><p>Private inboxes are available for real worker and manager accounts.</p></div>':`<section id="dm-root" class="panel dm-layout"><aside id="dm-sidebar" class="dm-sidebar">${loaded?sidebar():'<p>Loading your inbox…</p>'}</aside><div id="dm-thread-area">${threadHTML()}</div></section><p id="dm-load-error" class="form-error" role="alert">${esc(error)}</p>`}`;}
  function mount(){badges();if(!isLive())return;bind();const select=document.querySelector('#dm-recipient'),userId=getUser()?.id;if(select)select.value=selected?.participantA===userId?selected.participantB:selected?.participantB===userId?selected.participantA:'';restoreScroll();scheduleRead();if(!loaded)poll();}
  function reset(){generation++;clearTimeout(readTimer);reading=null;readRevision++;pollAgain=false;inbox={contacts:[],threads:[],unreadCount:0};selected=null;messages=[];hasMore=false;loaded=false;polling=false;error='';drafts.clear();scrollPositions.clear();confirmedReads.clear();badges();}
  setInterval(()=>{if(!document.hidden)poll();},10000);
  document.addEventListener('visibilitychange',()=>{scheduleRead();if(!document.hidden)poll();});
  window.addEventListener('scroll',scheduleRead,{passive:true});
  window.addEventListener('resize',scheduleRead,{passive:true});
  window.visualViewport?.addEventListener('resize',scheduleRead,{passive:true});
  window.visualViewport?.addEventListener('scroll',scheduleRead,{passive:true});
  document.addEventListener('click',scheduleRead);
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
