// Executes actual app.mjs + dm-ui.mjs + receipt-ui.mjs against an injected,
// authorized in-memory backend. jsdom is DOM coverage, not browser/layout QA.
import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const root=process.env.RELAY_RECEIPT_JSDOM_ROOT;
if(!root?.startsWith('/tmp/'))throw Error('Set RELAY_RECEIPT_JSDOM_ROOT to the pinned local jsdom package.');
const {JSDOM}=await import(pathToFileURL(root+'/lib/api.js'));
export const apiURL='https://relay.fixture.invalid/relay';
export const tick=()=>new Promise(resolve=>setImmediate(resolve));
export async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('DOM condition was not reached');}
export async function mountReceiptApp({token,backend,endpoint='/manager-receipts',hash='messages'}){
  if(!vm.SourceTextModule)throw Error('Run app DOM tests with --experimental-vm-modules.');
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://website.fixture.invalid/#'+hash,runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom,context=dom.getInternalVMContext(),calls=[],logs=[];
  Object.assign(window,{TextEncoder,TextDecoder,Request,Response,Headers,AbortController,structuredClone});
  Object.defineProperty(window,'crypto',{value:webcrypto});
  window.console={log:(...x)=>logs.push(x),warn:(...x)=>logs.push(x),error:(...x)=>logs.push(x)};
  window.setInterval=()=>0;window.clearInterval=()=>{};
  window.HTMLElement.prototype.scrollIntoView=function(){};
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  window.fetch=async(url,options)=>{calls.push({url,options});return backend(url,options);};
  if(token)window.sessionStorage.setItem('relay-account-session-v2',JSON.stringify({base:apiURL,token,expiresAt:'2999-01-01T00:00:00Z'}));
  const cache=new Map();
  const synthetic={
    'config.mjs':`export const API_BASE=${JSON.stringify(apiURL)};`,
    'receipt-config.mjs':`export const RECEIPT_ENDPOINT=${JSON.stringify(endpoint)};`,
    'hardware-ui.mjs':"export function createHardware(){return {reset(){},mount(){},poll(){},render(){return ''}};}",
    'updates-ui.mjs':"export function createUpdates(){return {reset(){},mount(){},poll(){},render(){return ''}};}",
    'sidebar.mjs':"export function createSidebar(){return {toggle(){return false},render(){return '<a href=\"#messages\">Messages</a><a href=\"#inbox\">Inbox</a><a href=\"#tasks\">Tasks</a>'}};}"
  };
  function module(url){const parsed=new URL(url);parsed.search='';const key=parsed.href;if(cache.has(key))return cache.get(key);
    const path=fileURLToPath(parsed),name=path.split('/').at(-1),code=Object.hasOwn(synthetic,name)?synthetic[name]:readFileSync(path,'utf8');
    const value=new vm.SourceTextModule(code,{context,identifier:key});cache.set(key,value);return value;
  }
  const main=module(new URL('../../app.mjs',import.meta.url));
  await main.link((specifier,ref)=>module(new URL(specifier,ref.identifier)));await main.evaluate();
  return {dom,window,document:window.document,calls,logs,close:()=>window.close()};
}
