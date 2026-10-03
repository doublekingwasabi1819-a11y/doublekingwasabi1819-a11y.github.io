import {createHash} from 'node:crypto';

const script=`
let credential='',enabled=false,busy=false,imageURL='',generation=0;
const status=document.querySelector('#status'),image=document.querySelector('#screen');
const connect=document.querySelector('#connect'),pause=document.querySelector('#pause');
const token=document.querySelector('#token'),open=document.querySelector('#open');
function clearImage(){image.hidden=true;image.removeAttribute('src');if(imageURL)URL.revokeObjectURL(imageURL);imageURL='';}
function disconnect(message='Disconnected'){generation++;enabled=false;credential='';open.disabled=true;pause.disabled=true;clearImage();status.textContent=message;}
async function request(path,options={},auth=credential){
 const response=await fetch(path,{...options,cache:'no-store',credentials:'omit',headers:{Authorization:'Bearer '+auth,...options.headers}});
 if(!response.ok){const error=new Error(response.status===401||response.status===403?'Connection expired or unavailable.':response.status===404?'Start the browser to see its screen.':'Browser operation unavailable.');error.authFailure=response.status===401||response.status===403;throw error;}
 return response;
}
async function snapshot(){
 if(!enabled||busy)return;busy=true;const epoch=generation,auth=credential;
 try{const response=await request('/viewer/snapshot',{},auth);const blob=await response.blob();if(!enabled||epoch!==generation)return;
  const next=URL.createObjectURL(blob);image.src=next;if(imageURL)URL.revokeObjectURL(imageURL);imageURL=next;image.hidden=false;status.textContent='Connected · masked browser view';
 }catch(error){if(epoch===generation){if(error.authFailure)disconnect(error.message);else status.textContent='Browser view unavailable. Start the browser or reconnect.';}}finally{busy=false;}
}
connect.addEventListener('click',()=>{const next=token.value;token.value='';disconnect();credential=next;if(!credential){status.textContent='Enter your connection token.';return;}enabled=true;open.disabled=false;pause.disabled=false;snapshot();});
pause.addEventListener('click',()=>disconnect());
open.addEventListener('click',async()=>{if(!enabled)return;const epoch=generation,auth=credential;open.disabled=true;try{await request('/viewer/open',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},auth);if(epoch===generation)await snapshot();}catch(error){if(epoch===generation){if(error.authFailure)disconnect(error.message);else status.textContent='Browser operation unavailable.';}}finally{if(epoch===generation)open.disabled=!enabled;}});
setInterval(snapshot,750);
addEventListener('pagehide',()=>disconnect());
`;
const style=`body{margin:0;padding:24px;background:#f4f6fa;color:#172033;font:16px system-ui,sans-serif}main{max-width:1280px;margin:auto}h1{font-size:24px;margin:0 0 8px}p{color:#526174}label{display:block;margin:20px 0 6px}input{padding:10px;width:min(460px,80%);font:inherit}button{padding:10px 16px;margin:8px 6px 8px 0;font:inherit;cursor:pointer}button:disabled{cursor:default}img{display:block;max-width:100%;border:1px solid #ccd4e0;background:white}img[hidden]{display:none}#status{min-height:24px}`;
const hash=value=>`'sha256-${createHash('sha256').update(value).digest('base64')}'`;

/** Public shell contains no embedded credentials, account state or callbacks. */
export function createViewerShell({target='fixture'}={}){
 if(!['fixture','relay'].includes(target))throw new TypeError('A fixed viewer target is required.');
 const title=target==='fixture'?'Relay browser test':'Relay browser';
 const body=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title><style>${style}</style></head><body><main><h1>${title}</h1><p>A private, masked view of the browser connected to your worker.</p><label for="token">Connection token</label><input id="token" type="password" autocomplete="off" spellcheck="false"><div><button id="connect">Connect</button><button id="open" disabled>Start browser</button><button id="pause" disabled>Disconnect</button></div><p id="status" role="status">Disconnected</p><img id="screen" alt="Masked browser screen" hidden></main><script>${script}</script></body></html>`;
 return Object.freeze({body,contentType:'text/html',headers:{
  'content-security-policy':`default-src 'none'; script-src ${hash(script)}; style-src ${hash(style)}; connect-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
 }});
}

const errorStatus=code=>({AUTH_REQUIRED:401,FORBIDDEN:403,NOT_FOUND:404,STALE_SESSION:409,LIMIT:429}[code]||503);
function failure(result){return Response.json({error:'Browser operation unavailable.'},{status:errorStatus(result?.structuredContent?.error?.code)});}
/** Authentication/body limits are enforced by the HTTP host before these routes. */
export function createViewerRoutes(controller){
 if(!controller||typeof controller.snapshot!=='function'||typeof controller.callTool!=='function')throw new TypeError('A trusted controller is required.');
 return {
  '/viewer/snapshot':{methods:['GET'],async handler(_request,context){
   const result=await controller.snapshot(context);if(result.isError)return failure(result);
   const image=result.content?.find(item=>item.type==='image'&&item.mimeType==='image/png');
   if(!image)return failure();
   return new Response(Buffer.from(image.data,'base64'),{headers:{'content-type':'image/png'}});
  }},
  '/viewer/open':{methods:['POST'],async handler(request,context){
   let body;try{body=await request.json();}catch{return Response.json({error:'Invalid request.'},{status:400});}
   if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).length)return Response.json({error:'Invalid request.'},{status:400});
   const result=await controller.callTool({name:'browser_open',arguments:{}},context);
   return result.isError?failure(result):Response.json({state:'open'});
  }}
 };
}
