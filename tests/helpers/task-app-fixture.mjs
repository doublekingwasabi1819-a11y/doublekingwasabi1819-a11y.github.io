import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const root=process.env.RELAY_JSDOM_ROOT||'/tmp/relay-receipt-ui-test/node_modules/jsdom';
if(JSON.parse(readFileSync(root+'/package.json','utf8')).version!=='26.1.0')throw Error('Use pinned jsdom 26.1.0.');
const {JSDOM}=await import(pathToFileURL(root+'/lib/api.js'));
export async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('DOM condition was not reached');}
export async function mountTaskApp(){
 const dom=new JSDOM(readFileSync(new URL('../../index.html',import.meta.url),'utf8'),{url:'https://local.fixture.invalid/',runScripts:'outside-only',pretendToBeVisual:true});
 const {window}=dom,context=dom.getInternalVMContext(),errors=[];
 Object.assign(window,{TextEncoder,TextDecoder,Request,Response,Headers,AbortController,structuredClone});Object.defineProperty(window,'crypto',{value:webcrypto});
 window.addEventListener('error',e=>errors.push(e.error||e.message));window.setInterval=()=>0;window.clearInterval=()=>{};
 window.fetch=()=>{throw Error('No external network allowed in task DOM test.');};
 window.HTMLElement.prototype.scrollIntoView=function(){};window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const cache=new Map();function module(url){const parsed=new URL(url);parsed.search='';const key=parsed.href;if(cache.has(key))return cache.get(key);const file=fileURLToPath(parsed);let code=file.endsWith('/config.mjs')?"export const API_BASE='';":readFileSync(file,'utf8');if(file.endsWith('/app.mjs'))code+='\nexport const testState=()=>state; export function testContext(snapshot){useContext(snapshot);mode=\"live\";render();} export const testMutate=mutate;';const result=new vm.SourceTextModule(code,{context,identifier:key});cache.set(key,result);return result;}
 const main=module(new URL('../../app.mjs',import.meta.url));await main.link((specifier,ref)=>module(new URL(specifier,ref.identifier)));await main.evaluate();
 const document=window.document;
 return {window,document,errors,state:()=>structuredClone(main.namespace.testState()),context:snapshot=>main.namespace.testContext(snapshot),mutate:(type,payload)=>main.namespace.testMutate(type,payload),close:()=>window.close(),click:async(action,id)=>{const el=document.querySelector(`[data-action="${action}"]${id?`[data-id="${id}"]`:''}`);if(!el)throw Error('Missing action '+action);el.click();await new Promise(r=>setImmediate(r));},submit:async()=>{document.querySelector('#dialog-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));},field:(name,value)=>{document.querySelector(`#dialog-form [name="${name}"]`).value=value;},navigate:async hash=>{window.location.hash=hash;await new Promise(r=>setTimeout(r,10));}};
}
