// Local-only browser test: all non-local network requests are blocked.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/opt/codex/cua_node/lib/node_modules/playwright');
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'validation/task-controls');await mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');let file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(root+path.sep))throw Error();const data=await readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.mjs')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html'});res.end(data);}catch{res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==base)return route.abort();if(url.pathname==='/config.mjs')return route.fulfill({contentType:'text/javascript',body:"export const API_BASE='';"});return route.continue();});
const click=action=>page.locator(`[data-action="${action}"]`).first().click();
const submit=label=>page.getByRole('button',{name:label,exact:true}).click();
const modal=page.locator('#modal');
const assertClosed=async()=>assert.equal(await modal.evaluate(e=>e.open),false);
async function exportState(){const download=page.waitForEvent('download');await click('export');const item=await download;return JSON.parse(await readFile(await item.path(),'utf8'));}
try{
 await page.goto(base);await click('demo');await page.locator('a[href="#tasks"]').first().click();await page.waitForSelector('#task-search');
 await click('new-task');await page.getByLabel('Task title',{exact:true}).fill('Browser shared task');await page.getByLabel('Done when',{exact:true}).fill('Two agents can collaborate');await page.locator('[name="agentIds"]').nth(0).check();await page.locator('[name="agentIds"]').nth(1).check();await submit('Create task');await assertClosed();
 let snapshot=await exportState();let task=snapshot.tasks.find(t=>t.title==='Browser shared task');assert.equal(task.assignees.length,2);const id=task.id;
 await page.locator(`[data-action="task"][data-id="${id}"]`).click();assert.match(await modal.textContent(),/Forge, Scout/);await click('task-edit');await page.getByLabel('Task title',{exact:true}).fill('Browser shared task edited');await submit('Save task');snapshot=await exportState();assert.equal(snapshot.tasks.find(t=>t.id===id).title,'Browser shared task edited');assert.equal(snapshot.tasks.find(t=>t.id===id).assignees.length,2);
 await page.locator(`[data-action="task"][data-id="${id}"]`).click();await click('task-agents');await page.locator('[name="agentIds"]').nth(0).uncheck();await page.locator('[name="agentIds"]').nth(2).check();await submit('Save agents');snapshot=await exportState();task=snapshot.tasks.find(t=>t.id===id);assert.equal(task.assignees.length,2);assert.equal(task.owner,snapshot.agents.find(a=>a.name==='Scout').id);
 await page.locator('#task-filter').selectOption(task.assignees[1].agentId);assert.equal(await page.locator(`[data-action="task"][data-id="${id}"]`).count(),1);await page.locator('#task-filter').selectOption('');
 await page.locator(`[data-action="task"][data-id="${id}"]`).click();await click('task-delete');await submit('Cancel');await assertClosed();snapshot=await exportState();assert.equal(snapshot.tasks.find(t=>t.id===id).deletedAt,undefined);
 await page.locator(`[data-action="task"][data-id="${id}"]`).click();await click('task-delete');await submit('Delete task');await assertClosed();assert.equal(await page.locator(`[data-action="task"][data-id="${id}"]`).count(),0);snapshot=await exportState();assert.ok(snapshot.tasks.find(t=>t.id===id).deletedAt);
 await click('deleted-tasks');assert.match(await modal.textContent(),/Browser shared task edited/);await click('task-restore');await submit('Restore task');await assertClosed();snapshot=await exportState();task=snapshot.tasks.find(t=>t.id===id);assert.equal(task.deletedAt,undefined);assert.equal(task.assignees.length,2);assert.equal(task.status,'working');
 await page.locator(`[data-action="task"][data-id="${id}"]`).click();await page.getByLabel('Progress and next steps',{exact:true}).fill('Browser checkpoint');await submit('Save update');snapshot=await exportState();assert.equal(snapshot.tasks.find(t=>t.id===id).checkpoint,'Browser checkpoint');
 // Long names, small screen and escaping are exercised with real form entry.
 await page.locator('a[href="#team"]').first().click();await click('new-agent');await page.getByLabel('Agent name',{exact:true}).fill('A very long agent name with <markup> & difficult wrapping');await submit('Add agent');snapshot=await exportState();const long=snapshot.agents.at(-1);await page.locator(`[data-action="session"][data-id="${long.id}"]`).click();await submit('Create session and handoff');await click('close');
 await page.locator('a[href="#tasks"]').first().click();await page.locator(`[data-action="task"][data-id="${id}"]`).click();await click('task-agents');await page.locator(`[name="agentIds"][value="${long.id}"]`).check();await submit('Save agents');
 await page.screenshot({path:path.join(out,'desktop-task-board.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.locator(`[data-action="task"][data-id="${id}"]`).click();await click('task-agents');await page.screenshot({path:path.join(out,'mobile-multiple-agents.png'),fullPage:true});assert.equal(await modal.locator('markup').count(),0);assert.equal(await modal.evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);await submit('Cancel');await page.screenshot({path:path.join(out,'mobile-task-board.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log('PASS: browser create/edit/multi-assignee/filter/progress/delete-cancel/delete/restore, escaped long names, mobile dialog overflow and screenshots.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
