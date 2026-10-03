// Pure Update room policy. Authentication, persistence and GitHub IO live elsewhere.
export const REQUIRED_APPROVALS=1;
export const DEFAULT_APPROVAL_POLICY=Object.freeze({mode:'one',allowSelfApproval:false});
export function approvalPolicy(value=DEFAULT_APPROVAL_POLICY){
  if(!value||typeof value!=='object'||Array.isArray(value)||!['one','manager','agents'].includes(value.mode)||typeof value.allowSelfApproval!=='boolean')throw new UpdatePolicyError('Choose a valid approval policy.','INVALID_POLICY',400);
  return {mode:value.mode,allowSelfApproval:value.allowSelfApproval};
}
export function mayReview(proposal,user,policy=DEFAULT_APPROVAL_POLICY){
  const settings=approvalPolicy(policy);
  if(settings.mode==='manager'&&user.role!=='manager')return false;
  if(settings.mode==='agents'&&user.role!=='worker')return false;
  return user.role==='manager'||settings.allowSelfApproval||!authorIds(proposal).includes(user.id);
}
export const UPDATE_LIMITS=Object.freeze({files:40,fileBytes:200000,totalBytes:750000,title:180,description:8000,review:4000});
const SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OPEN=new Set(['draft','staged','publishing']);
const EDITABLE=new Set(['draft','staged']);
const EXTENSIONS=new Set(['html','css','mjs','js','svg','json','md','txt']);
const FORBIDDEN_DIRS=new Set(['backend','tests','scripts','node_modules']);
const PROTECTED_FILES=new Set(['updates-policy.mjs','agents.md','readme.md','config.mjs','bridge.mjs','relay-cli.mjs','github.mjs']);
const encoder=new TextEncoder();

export class UpdatePolicyError extends Error {
  constructor(message,code='INVALID_UPDATE',status=400){super(message);this.name='UpdatePolicyError';this.code=code;this.status=status;}
}
const fail=(message,code,status)=>{throw new UpdatePolicyError(message,code,status);};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const copy=value=>structuredClone(value);
function text(value,label,max,{empty=false}={}){
  if(typeof value!=='string')fail(`${label} must be text.`);
  const normalized=value.trim();
  if((!empty&&!normalized)||normalized.length>max)fail(`${label} must be ${empty?'at most':'between 1 and'} ${max} characters.`);
  if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized))fail(`${label} contains control characters.`);
  return normalized;
}
function identity(user){
  if(!record(user)||!['worker','manager'].includes(user.role)||user.enabled===false||user.disabled===true)fail('An active worker or manager account is required.','FORBIDDEN',403);
  return {id:text(user.id,'Account ID',128),name:text(user.name,'Account name',180),role:user.role};
}
function timestamp(at){
  const value=at??new Date().toISOString();
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))fail('A valid timestamp is required.');
  return new Date(value).toISOString();
}
function authorIds(proposal){return [...new Set([proposal.authorId,...(Array.isArray(proposal.authorIds)?proposal.authorIds:[])].filter(id=>typeof id==='string'&&id))];}
function assertEditable(proposal){
  if(!record(proposal)||!EDITABLE.has(proposal.status))fail('This update can no longer be changed or reviewed.','UPDATE_CLOSED',409);
}
function safePath(path){
  if(typeof path!=='string'||path.length>240||!path||! /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path))fail('Files must use safe relative paths.','UNSAFE_PATH');
  const segments=path.split('/');
  if(segments.some(segment=>!segment||segment.startsWith('.')))fail(`Unsafe file path: ${path}`,'UNSAFE_PATH');
  if(segments.some(segment=>FORBIDDEN_DIRS.has(segment.toLowerCase())))fail(`The Update room cannot change ${path}.`,'PROTECTED_FILE');
  const filename=segments.at(-1).toLowerCase(),extension=filename.split('.').at(-1);
  if(PROTECTED_FILES.has(filename)||/^package.*\.json$/.test(filename)||!filename.includes('.')||!EXTENSIONS.has(extension))fail(`The Update room cannot change ${path}.`,'PROTECTED_FILE');
  return path;
}
function assertNoCredentials(content,path){
  // Only high-confidence secret formats: public IDs and publishable keys remain valid.
  if(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(content)||/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/.test(content)||/\bsb_secret_[A-Za-z0-9_-]{20,}\b/.test(content))fail(`Remove the private credential from ${path} before submitting.`,'SECRET_DETECTED');
  for(const match of content.matchAll(/\beyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\b/g)){
    try{
      const part=match[1].replaceAll('-','+').replaceAll('_','/');
      const payload=JSON.parse(atob(part.padEnd(Math.ceil(part.length/4)*4,'=')));
      if(['service_role','supabase_admin'].includes(payload.role))fail(`Remove the privileged credential from ${path} before submitting.`,'SECRET_DETECTED');
    }catch(error){if(error instanceof UpdatePolicyError)throw error;}
  }
}

/** Validate and normalize the untrusted complete replacement bundle. No input is mutated. */
export function validateBundle(data){
  if(!record(data))fail('An update bundle is required.');
  const title=text(data.title,'Title',UPDATE_LIMITS.title);
  const description=text(data.description??'','Description',UPDATE_LIMITS.description,{empty:true});
  assertNoCredentials(title,'the update title');assertNoCredentials(description,'the update description');
  const base=typeof data.base==='string'?data.base.toLowerCase():'';
  if(!SHA.test(base))fail('The update must identify its exact 40-character base commit.','INVALID_BASE');
  if(!Array.isArray(data.files)||!data.files.length||data.files.length>UPDATE_LIMITS.files)fail(`Submit between 1 and ${UPDATE_LIMITS.files} files.`,'FILE_LIMIT');
  const seen=new Set(),segmentCases=new Map();let total=0;
  const files=data.files.map(file=>{
    if(!record(file))fail('Every file needs a path and text content.');
    const path=safePath(file.path),key=path.toLowerCase();
    if(seen.has(key))fail(`Duplicate or case-colliding file path: ${path}`,'DUPLICATE_PATH');
    seen.add(key);
    const segments=path.split('/');
    for(let index=1;index<=segments.length;index++){
      const prefix=segments.slice(0,index).join('/'),folded=prefix.toLowerCase();
      if(segmentCases.has(folded)&&segmentCases.get(folded)!==prefix)fail(`Case-colliding directory or file path: ${path}`,'DUPLICATE_PATH');
      segmentCases.set(folded,prefix);
    }
    if(typeof file.content!=='string')fail(`Content for ${path} must be text.`);
    // Reject invalid Unicode instead of silently replacing it during UTF-8 upload.
    if(!file.content.isWellFormed())fail(`Content for ${path} contains invalid Unicode.`);
    const size=encoder.encode(file.content).length;
    if(size>UPDATE_LIMITS.fileBytes)fail(`${path} exceeds ${UPDATE_LIMITS.fileBytes} bytes.`,'FILE_LIMIT');
    total+=size;
    if(total>UPDATE_LIMITS.totalBytes)fail(`The update exceeds ${UPDATE_LIMITS.totalBytes} bytes in total.`,'BUNDLE_LIMIT');
    assertNoCredentials(file.content,path);
    return {path,content:file.content};
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  for(const {path} of files){
    const segments=path.toLowerCase().split('/');
    for(let index=1;index<segments.length;index++)if(seen.has(segments.slice(0,index).join('/')))fail(`A file also appears as a directory: ${path}`,'DUPLICATE_PATH');
  }
  return {title,description,base,files};
}
async function bundleDigest(bundle,version){
  const canonical=JSON.stringify({version,title:bundle.title,description:bundle.description,base:bundle.base,files:bundle.files});
  const bytes=await crypto.subtle.digest('SHA-256',encoder.encode(canonical));
  return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function createProposal(data,user,at){
  const account=identity(user),bundle=validateBundle(data),createdAt=timestamp(at);
  if(typeof data.id!=='string'||!UUID.test(data.id))fail('A valid unique update ID is required.','INVALID_ID');
  return {id:data.id.toLowerCase(),...bundle,authorId:account.id,authorName:account.name,authorIds:[account.id],version:1,digest:await bundleDigest(bundle,1),reviews:[],status:'draft',createdAt,updatedAt:createdAt};
}
export async function reviseProposal(old,data,user,at){
  const account=identity(user);assertEditable(old);
  if(account.role!=='manager'&&account.id!==old.authorId)fail('Only the author or manager can replace this update.','FORBIDDEN',403);
  if(!record(data)||!Number.isSafeInteger(data.expectedVersion)||data.expectedVersion!==old.version||(data.expectedDigest!==undefined&&data.expectedDigest!==old.digest))fail('This update changed. Reload it before replacing its files.','VERSION_CONFLICT',409);
  const bundle=validateBundle(data),version=old.version+1;
  if(!Number.isSafeInteger(version))fail('The update version is invalid.','VERSION_CONFLICT',409);
  // Do not carry forward any staging/check/publication metadata from the old content.
  return {id:old.id,...bundle,authorId:old.authorId,authorName:old.authorName,authorIds:[...new Set([...authorIds(old),account.id])],version,digest:await bundleDigest(bundle,version),reviews:[],status:'draft',createdAt:old.createdAt,updatedAt:timestamp(at)};
}
export function reviewProposal(old,data,user,at,policy=DEFAULT_APPROVAL_POLICY){
  const account=identity(user);assertEditable(old);
  if(!mayReview(old,account,policy))fail('This account cannot sign off under the current manager policy.','REVIEW_FORBIDDEN',403);
  if(!record(data)||!DIGEST.test(data.digest??'')||data.digest!==old.digest)fail('This update changed. Review its current version.','VERSION_CONFLICT',409);
  if(!['approve','changes'].includes(data.decision))fail('Choose approve or changes.','INVALID_REVIEW');
  const body=text(data.body??'','Review',UPDATE_LIMITS.review,{empty:data.decision==='approve'}),atTime=timestamp(at);
  const review={reviewerId:account.id,reviewerName:account.name,reviewerRole:account.role,decision:data.decision,body,digest:old.digest,createdAt:atTime};
  return {...copy(old),reviews:[...(old.reviews??[]).filter(item=>item.reviewerId!==account.id).map(copy),review],updatedAt:atTime};
}

/** A green result is an exact-version gate; callers must enforce it again while publishing. */
export function readiness(proposal,{main,connected=false,proposals=[],activeAccountIds,activeAccounts,policy=DEFAULT_APPROVAL_POLICY,managerOverride=false}={}){
  const blockers=[],pending=[],warnings=[];
  const add=(code,message,wait=false)=>(wait?pending:blockers).push({code,message});
  const settings=approvalPolicy(policy),required=settings.mode==='agents'?2:1;
  const accounts=activeAccounts===undefined?null:new Map(activeAccounts.map(a=>[a.id,a]));
  const authors=new Set(authorIds(proposal));
  const active=activeAccountIds===undefined?null:new Set(activeAccountIds);
  const latest=new Map();
  for(const review of proposal.reviews??[]){
    const account=accounts?.get(review?.reviewerId);
    const role=account?.role||review?.reviewerRole;
    const eligible=(!accounts||account)&&(!active||active.has(review?.reviewerId))&&(settings.mode==='one'||settings.mode==='manager'&&role==='manager'||settings.mode==='agents'&&role==='worker')&&(role==='manager'||settings.allowSelfApproval||!authors.has(review?.reviewerId));
    if(review?.digest===proposal.digest&&typeof review.reviewerId==='string'&&eligible&&['approve','changes'].includes(review.decision))latest.set(review.reviewerId,review);
  }
  const approvalCount=[...latest.values()].filter(review=>review.decision==='approve').length;
  const common={approvalCount,requiredApprovals:required,approvalMode:settings.mode,allowSelfApproval:settings.allowSelfApproval};
  if(proposal.status==='published'&&proposal.deployment?.state==='failure'){
    const message=proposal.deployment.summary||'GitHub Pages deployment failed.';
    return {...common,state:'blocked',ready:false,color:'red',reasons:[message],warnings:[],blockers:[{code:'DEPLOYMENT_FAILED',message}]};
  }
  if(['published','withdrawn'].includes(proposal.status))return {...common,state:proposal.status,ready:false,color:proposal.status==='published'?'green':'red',reasons:[],warnings:[],blockers:[]};
  if(proposal.status==='publishing')return {...common,state:'publishing',ready:false,color:'amber',reasons:['This update is publishing.'],warnings:[],blockers:[{code:'PUBLISHING',message:'This update is publishing.'}]};
  if(!OPEN.has(proposal.status))add('INVALID_STATUS','This update has an invalid status.');
  if(!DIGEST.test(proposal.digest??''))add('INVALID_DIGEST','The update does not have a valid version digest.');
  if(!connected)add('NOT_CONNECTED','The repository publishing connection is not set up.');
  if(!SHA.test(main??''))add('UNKNOWN_BASE','The current site version could not be checked.');
  else if(main!==proposal.base)add('STALE_BASE','The site changed since this update was prepared. Rebase and review it again.');
  if(proposals.some(other=>other.id!==proposal.id&&other.status==='publishing'))add('PUBLISH_LOCK','Another update is publishing. Wait for it to finish.');
  if(proposal.status!=='staged')add('NOT_STAGED','This version has not been staged for automatic checks.',true);
  if(!SHA.test(proposal.github?.head??''))add('MISSING_HEAD','A checked GitHub commit is required.',true);
  const checks=proposal.checks;
  if(!checks||checks.state==='pending')add('CHECKS_PENDING','Automatic checks are still pending.',true);
  else if(checks.state!=='success')add('CHECKS_FAILED',checks.summary||'Automatic checks failed.');
  else if(checks.head!==proposal.github?.head||checks.base!==proposal.base)add('STALE_CHECKS','Checks do not match this exact update and site version.');
  if(!managerOverride&&[...latest.values()].some(review=>review.decision==='changes'))add('CHANGES_REQUESTED','A reviewer requested changes.');
  if(!managerOverride&&approvalCount<required)add('REVIEWS_PENDING',settings.mode==='manager'?'The manager’s sign-off is required.':`${required-approvalCount} more ${settings.mode==='agents'?'agent ':''}sign-off${required-approvalCount===1?' is':'s are'} required.`,true);
  const paths=new Set((proposal.files??[]).map(file=>file.path.toLowerCase()));
  for(const other of proposals){
    if(other.id===proposal.id||!OPEN.has(other.status))continue;
    const overlap=(other.files??[]).map(file=>file.path).filter(path=>paths.has(path.toLowerCase())).sort();
    if(overlap.length)warnings.push(`Also edited in “${other.title}”: ${overlap.join(', ')}. Publishing either update will require the other to be rebased.`);
  }
  const state=blockers.length?'blocked':pending.length?'reviewing':'ready';
  return {...common,state,ready:state==='ready',color:state==='ready'?'green':state==='reviewing'?'yellow':'red',reasons:[...blockers,...pending].map(item=>item.message),warnings,blockers:[...blockers,...pending]};
}

/** Whitelist data exposed to authenticated room participants; never spread storage records. */
export function publicProposal(proposal,repoInfo={}){
  const result={};
  for(const key of ['id','title','description','authorId','authorName','version','digest','base','status','createdAt','updatedAt','publishedAt','publishedBy','publishedCommit','managerOverride','publishStartedAt','publishError'])if(proposal[key]!==undefined)result[key]=proposal[key];
  result.authorIds=authorIds(proposal);
  result.files=(proposal.files??[]).map(({path,content})=>({path,content}));
  result.reviews=(proposal.reviews??[]).map(({reviewerId,reviewerName,reviewerRole,decision,body,digest,createdAt})=>({reviewerId,reviewerName,reviewerRole,decision,body,digest,createdAt}));
  for(const [key,fields] of [['github',['branch','head','pr','url']],['checks',['state','summary','url','head','base']],['deployment',['state','summary','url']]]){
    if(proposal[key]){result[key]={};for(const field of fields)if(proposal[key][field]!==undefined)result[key][field]=proposal[key][field];}
  }
  result.readiness=readiness(proposal,repoInfo);
  result.overrideReady=readiness(proposal,{...repoInfo,managerOverride:true}).ready;
  result.canReview=Boolean(repoInfo.user&&mayReview(proposal,repoInfo.user,repoInfo.policy||DEFAULT_APPROVAL_POLICY));
  return result;
}
