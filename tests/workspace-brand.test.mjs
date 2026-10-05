import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {workspaceBrand,renderWorkspaceBrand} from '../workspace-brand.mjs';
test('manager name and initial come from authenticated account',()=>{
 assert.deepEqual(workspaceBrand({role:'manager',name:' CoderCoder '}),{name:'CoderCoder',initial:'C'});
 assert.deepEqual(workspaceBrand({role:'manager',name:'Alice'}),{name:'Alice',initial:'A'});
});
test('worker and empty account never impersonate a manager',()=>{
 for(const u of [null,{role:'worker',name:'Forge'},{role:'manager',name:' '},{role:'manager',name:12}]) assert.deepEqual(workspaceBrand(u),{name:'Manager',initial:'M'});
 assert.deepEqual(workspaceBrand(null,'demo'),{name:'Example manager',initial:'E'});
});
test('Unicode first grapheme is preserved',()=>{
 assert.equal(workspaceBrand({role:'manager',name:'👩🏽‍💻 Alex'}).initial,'👩🏽‍💻');
});
test('name remains text and resets across accounts',()=>{
 const label={},mark={},root={querySelector:s=>s==='#project-name'?label:mark};
 renderWorkspaceBrand(root,{role:'manager',name:'<img src=x onerror=alert(1)>'},'live');
 assert.equal(label.textContent,'<img src=x onerror=alert(1)>');assert.equal(label.title,label.textContent);
 renderWorkspaceBrand(root,{role:'worker',name:'Forge'},'live');assert.equal(label.textContent,'Manager');assert.equal(mark.textContent,'M');
});
test('sidebar retains subtitle, accessible full label and responsive truncation',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const css=readFileSync(new URL('../ui.css',import.meta.url),'utf8');
 assert.match(html,/<small>Agent workspace<\/small>/);assert.match(html,/id="project-initial" aria-hidden="true"/);assert.match(html,/id="project-name" dir="auto"/);
 assert.match(css,/#project-name[^}]*text-overflow: ellipsis/);
});

test('worker uses authenticated manager display name, never worker name',()=>{
 assert.deepEqual(workspaceBrand({role:'worker',name:'Forge'},'live',{name:'Ada Manager'}),{name:'Ada Manager',initial:'A'});
 assert.deepEqual(workspaceBrand({role:'worker',name:'Forge'},'live',{name:' '}),{name:'Manager',initial:'M'});
});
