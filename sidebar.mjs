// Keep disclosure state through board refreshes without changing route navigation.
export function createSidebar({names,icon,escape:h}) {
  const groups=[
    {id:'overview',label:'Overview',icon:'overview',routes:['team','messages','inbox','needs']},
    {id:'projects',label:'Projects',icon:'builds',routes:['memory','builds','connect']},
    {id:'utilize',label:'Utilize',icon:'connect',routes:['software','hardware']}
  ];
  const expanded=new Map(groups.map(group=>[group.id,false]));
  let previousView;
  return {
    toggle(id) {
      if(!expanded.has(id))return false;
      const open=!expanded.get(id);
      expanded.set(id,open);
      return open;
    },
    render({view,hasRoom=false,openQuestions=0}) {
      // Reveal deep links and Back/Forward destinations; don't undo an explicit
      // collapse when the same page refreshes in the background.
      if(view!==previousView){
        const selected=groups.find(group=>group.routes.includes(view));
        if(selected)expanded.set(selected.id,true);
        previousView=view;
      }
      const questions=openQuestions?`<span class="nav-badge" title="Open questions">${h(openQuestions)}</span>`:'';
      const unread='<span class="nav-badge" data-dm-count title="Unread private messages" hidden></span>';
      const link=key=>`<a href="#${key}" class="nav-item ${view===key?'active':''}"${view===key?' aria-current="page"':''}>${icon(key==='inbox'?'messages':key)}<span class="nav-link-label">${h(key==='updates'?'Update':names[key])}</span>${key==='inbox'?unread:key==='needs'?questions:key==='overview'?unread+questions:''}</a>`;
      const groupMarkup=group=>{
        const open=expanded.get(group.id),active=group.routes.includes(view);
        const chevron='<span class="nav-chevron" aria-hidden="true">›</span>';
        const attributes=`data-nav-group="${group.id}" aria-expanded="${open}" aria-controls="nav-group-${group.id}"`;
        const heading=group.id==='overview'
          ? `<div class="nav-group-heading ${active?'has-active-child':''}">${link('overview')}<button type="button" class="nav-disclosure" ${attributes} aria-label="Overview sections">${chevron}</button></div>`
          : `<button type="button" class="nav-item nav-group-toggle ${active?'active':''}" ${attributes}>${icon(group.icon)}<span class="nav-link-label">${group.label}</span>${chevron}</button>`;
        return `<div class="nav-group">${heading}<div id="nav-group-${group.id}" class="nav-group-links"${open?'':' hidden'}>${group.routes.map(link).join('')}</div></div>`;
      };
      return `<div class="nav-label">WORKSPACE</div>${hasRoom?link('room'):''}${groupMarkup(groups[0])}${link('tasks')}${groupMarkup(groups[1])}${groupMarkup(groups[2])}${link('updates')}`;
    }
  };
}
