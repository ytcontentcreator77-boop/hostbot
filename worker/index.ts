import { Hono } from "hono";
import { validateInitData } from "./auth";
import { appendWalletTransaction } from "./ledger";
import { constantTimeEqual, requireAdmin, type Env } from "./guards";

const app = new Hono<{ Bindings: Env }>();
app.use("/api/*",async(c,next)=>{
 const initData=c.req.header("X-Telegram-Init-Data")||"";
 if(initData){
  const identity=await validateInitData(initData,c.env.BOT_TOKEN);
  if(identity){
   const row=await c.env.DB.prepare("SELECT id,status FROM users WHERE telegram_id=?").bind(identity.id).first<{id:number;status:string}>();
   if(row?.status==="suspended"){
    const owner=(c.env.OWNER_IDS||"").split(",").map(x=>x.trim()).includes(String(identity.id));
    const staff=owner||!!(await c.env.DB.prepare("SELECT telegram_id FROM administrators WHERE telegram_id=?").bind(identity.id).first());
    if(!staff)return c.json({error:"ACCOUNT_SUSPENDED"},403);
   }
  }
 }
 await next();
});
app.get("/health", c => c.json({ ok: true, service: "hostpilot-control-plane" }));

async function sendHostPilotBotMessage(env:Env,chatId:number,text:string,privateChat:boolean){
 const keyboard=privateChat&&env.APP_URL&&/^https:\/\//i.test(env.APP_URL)
  ?{inline_keyboard:[[{text:"Open HostPilot",web_app:{url:env.APP_URL}}]]}
  :undefined;
 const response=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/sendMessage",{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true,...(keyboard?{reply_markup:keyboard}:{})})
 });
 const result=await response.json() as {ok?:boolean;description?:string};
 if(!response.ok||!result.ok)throw new Error("Telegram sendMessage failed: "+String(result.description||response.status));
}
app.post("/bot",async c=>{
 if(!c.env.BOT_TOKEN||!c.env.BOT_WEBHOOK_SECRET)return c.json({error:"BOT_NOT_CONFIGURED"},503);
 const supplied=c.req.header("X-Telegram-Bot-Api-Secret-Token")||"";
 if(!constantTimeEqual(supplied,c.env.BOT_WEBHOOK_SECRET))return c.json({error:"UNAUTHORIZED"},401);
 const update=await c.req.json<any>().catch(()=>null);
 const message=update?.message;
 const chatId=Number(message?.chat?.id);
 if(!Number.isSafeInteger(chatId)||chatId<=0||typeof message?.text!=="string")return c.json({ok:true});
 const privateChat=message?.chat?.type==="private";
 const command=String(message.text).trim().split(/\s+/,1)[0].split("@",1)[0].toLowerCase();
 const ownerIds=(c.env.OWNER_IDS||"").split(",").map((value:string)=>value.trim()).filter(Boolean);
 let reply="";
 if(command==="/start"||command==="/app"){
  reply="Welcome to HostPilot 👋\n\nDeploy and manage your Python and Node.js applications, files, backups and hosting plans from one place.\n\nTap Open HostPilot below to launch the secure Mini App.";
 }else if(command==="/help"){
  reply="HostPilot commands:\n/start — welcome and open the app\n/app — launch the HostPilot Mini App\n/help — show this help\n/admin — open the app's admin panel (administrators only).";
 }else if(command==="/admin"){
  if(!ownerIds.includes(String(message.from?.id))){
   const staff=await c.env.DB.prepare("SELECT telegram_id FROM administrators WHERE telegram_id=?").bind(Number(message.from?.id)||0).first();
   if(!staff){await sendHostPilotBotMessage(c.env,chatId,"This command is available to HostPilot administrators only.",privateChat);return c.json({ok:true});}
  }
  reply="HostPilot administration is available inside the Mini App. Open the app and choose Admin.";
 }else{
  reply="Use /start to open HostPilot, or /help to see available commands.";
 }
 await sendHostPilotBotMessage(c.env,chatId,reply,privateChat);
 return c.json({ok:true});
});
app.get("/api/public", async c => {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key='setup_done'").first<{value:string}>();
  return c.json({configured:row?.value==="1",service:"HostPilot"});
});
app.get("/api/me", async c => {
  const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);
  if(!user)return c.json({error:"UNAUTHORIZED"},401);
  await c.env.DB.prepare(`INSERT INTO users(telegram_id,first_name,last_name,username,language_code,last_seen_at)
    VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO UPDATE SET first_name=excluded.first_name,
    last_name=excluded.last_name,username=excluded.username,updated_at=CURRENT_TIMESTAMP,last_seen_at=CURRENT_TIMESTAMP`)
    .bind(user.id,user.first_name||"",user.last_name||null,user.username||null,user.language_code||"en").run();
  const profile=await c.env.DB.prepare("SELECT id,telegram_id,first_name,last_name,username,language_code,status,created_at FROM users WHERE telegram_id=?").bind(user.id).first<{id:number}>();
  if(profile){
    await c.env.DB.prepare("INSERT OR IGNORE INTO wallets(user_id,balance_minor,currency) VALUES(?,0,'USD')").bind(profile.id).run();
    await c.env.DB.prepare("UPDATE subscriptions SET status='expired' WHERE user_id=? AND status='active' AND datetime(expires_at)<=CURRENT_TIMESTAMP").bind(profile.id).run();
    await c.env.DB.prepare(`INSERT INTO subscriptions(user_id,plan_id,status,starts_at,expires_at)
      SELECT ?,id,'active',CURRENT_TIMESTAMP,datetime('now','+30 days') FROM plans
      WHERE slug='free' AND NOT EXISTS(SELECT 1 FROM subscriptions WHERE user_id=? AND status='active')`).bind(profile.id,profile.id).run();
  }
  const admin=await requireAdmin(c.req.raw,c.env);
  return c.json({user:profile,is_admin:!!admin});
});
app.get("/api/plans",async c=>{
  const result=await c.env.DB.prepare("SELECT id,name,slug,description,badge,price_minor,currency,duration_days,max_projects,max_upload_bytes,max_file_bytes,max_files,cpu_millicores,ram_mb,storage_mb,allowed_runtimes,enabled FROM plans WHERE enabled=1 ORDER BY sort_order,id").all();
  return c.json({plans:result.results||[]});
});
app.get("/api/dashboard",async c=>{
  const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);
  if(!user)return c.json({error:"UNAUTHORIZED"},401);
  const row=await c.env.DB.prepare("SELECT id FROM users WHERE telegram_id=?").bind(user.id).first<{id:number}>();
  if(!row)return c.json({error:"USER_NOT_REGISTERED"},404);
  const [projects,sub,wallets]=await Promise.all([
    c.env.DB.prepare("SELECT status,COUNT(*) AS count FROM projects WHERE user_id=? AND deleted_at IS NULL GROUP BY status").bind(row.id).all(),
    c.env.DB.prepare("SELECT s.status,s.expires_at,p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=? ORDER BY s.id DESC LIMIT 1").bind(row.id).first(),
    c.env.DB.prepare("SELECT balance_minor,currency FROM wallets WHERE user_id=? ORDER BY CASE currency WHEN 'USD' THEN 0 WHEN 'INR' THEN 1 ELSE 2 END").bind(row.id).all()
  ]);
  const walletList=(wallets.results||[]) as Array<{balance_minor:number;currency:string}>;
  const primaryWallet=walletList.find(item=>item.currency==="USD")||walletList[0]||{balance_minor:0,currency:"USD"};
  return c.json({projects:projects.results||[],subscription:sub||null,wallet:primaryWallet,wallets:walletList});
});
app.get("/api/languages",async c=>{
  const result=await c.env.DB.prepare("SELECT code,native_name FROM languages WHERE enabled=1 ORDER BY is_default DESC,native_name").all();
  return c.json({languages:result.results||[]});
});
app.post("/api/language",async c=>{
  const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);
  if(!user)return c.json({error:"UNAUTHORIZED"},401);
  const body=await c.req.json<{language_code:string}>().catch(()=>null);
  if(!body||typeof body.language_code!=="string"||body.language_code.length>8)return c.json({error:"INVALID_LANGUAGE"},400);
  const language=await c.env.DB.prepare("SELECT code FROM languages WHERE code=? AND enabled=1").bind(body.language_code).first();
  if(!language)return c.json({error:"LANGUAGE_NOT_AVAILABLE"},400);
  await c.env.DB.prepare("UPDATE users SET language_code=?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").bind(body.language_code,user.id).run();
  return c.json({ok:true,language_code:body.language_code});
});
app.get("/api/payment-methods",async c=>{
  const methods=await c.env.DB.prepare("SELECT id,name,kind,instructions,min_amount_minor,max_amount_minor,currency FROM payment_methods WHERE enabled=1 ORDER BY sort_order,id").all();
  return c.json({methods:methods.results||[]});
});
app.get("/api/payment-requests",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const rows=await c.env.DB.prepare("SELECT id,amount_minor,currency,status,reference,created_at,review_note FROM payment_requests WHERE user_id=(SELECT id FROM users WHERE telegram_id=?) ORDER BY created_at DESC LIMIT 30").bind(user.id).all();
 return c.json({requests:rows.results||[]});
});
app.post("/api/payment-requests",async c=>{
  const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);
  if(!user)return c.json({error:"UNAUTHORIZED"},401);
  const body=await c.req.json<{method_id:number;amount_minor:number;reference?:string}>().catch(()=>null);
  if(!body||!Number.isSafeInteger(body.amount_minor)||body.amount_minor<=0||!Number.isInteger(body.method_id))return c.json({error:"INVALID_REQUEST"},400);
  const account=await c.env.DB.prepare("SELECT id FROM users WHERE telegram_id=?").bind(user.id).first<{id:number}>();
  const method=await c.env.DB.prepare("SELECT id,min_amount_minor,max_amount_minor,currency FROM payment_methods WHERE id=? AND enabled=1").bind(body.method_id).first<{id:number;min_amount_minor:number;max_amount_minor:number|null;currency:string}>();
  if(!account||!method)return c.json({error:"METHOD_NOT_AVAILABLE"},404);
  if(body.amount_minor<method.min_amount_minor||(method.max_amount_minor!==null&&body.amount_minor>method.max_amount_minor))return c.json({error:"AMOUNT_OUT_OF_RANGE"},400);
  const id=crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO payment_requests(id,user_id,method_id,amount_minor,currency,reference,idempotency_key) VALUES(?,?,?,?,?,?,?)")
    .bind(id,account.id,method.id,body.amount_minor,method.currency,String(body.reference||"").slice(0,160)||null,"deposit:"+id).run();
  return c.json({id,status:"pending"},201);
});
async function sha256Hex(value:string):Promise<string>{
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
app.post("/api/agent/heartbeat",async c=>{
  const authorization=c.req.header("Authorization")||"";
  const token=authorization.startsWith("Bearer ")?authorization.slice(7):"";
  if(token.length<32)return c.json({error:"UNAUTHORIZED"},401);
  const hash=await sha256Hex(token);
  const node=await c.env.DB.prepare("SELECT id,enabled FROM vps_servers WHERE agent_token_hash=?").bind(hash).first<{id:number;enabled:number}>();
  if(!node||!node.enabled)return c.json({error:"UNAUTHORIZED"},401);
  const body=await c.req.json<{agent_version?:string;capacity?:Record<string,unknown>;status?:string}>().catch(()=>null);
  if(!body)return c.json({error:"INVALID_HEARTBEAT"},400);
  const capacity=JSON.stringify(body.capacity&&typeof body.capacity==="object"?body.capacity:{});
  await c.env.DB.prepare("UPDATE vps_servers SET status=?,capacity_json=?,agent_version=?,last_heartbeat_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=?")
    .bind(body.status==="unhealthy"?"unhealthy":"healthy",capacity,String(body.agent_version||"unknown").slice(0,40),node.id).run();
  return c.json({ok:true,server_id:node.id,server_time:new Date().toISOString()});
});

app.get("/api/projects",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const rows=await c.env.DB.prepare("SELECT p.id,p.name,p.runtime,p.runtime_version,p.status,p.entry_file,(SELECT detected_json FROM project_uploads u WHERE u.project_id=p.id ORDER BY u.created_at DESC LIMIT 1) AS detected_json,p.created_at,v.name AS server_name FROM projects p JOIN users u ON u.id=p.user_id LEFT JOIN vps_servers v ON v.id=p.server_id WHERE u.telegram_id=? AND p.deleted_at IS NULL ORDER BY p.created_at DESC").bind(user.id).all();
 return c.json({projects:rows.results||[]});
});
app.post("/api/projects",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const body=await c.req.json<{name:string;runtime:string;version:string}>().catch(()=>null);
 if(!body||typeof body.name!=="string"||body.name.trim().length<2||body.name.trim().length>48||!["python","nodejs"].includes(body.runtime))return c.json({error:"INVALID_PROJECT"},400);
 const versions:Record<string,string[]>={python:["3.11","3.12","3.13"],nodejs:["20","22","24"]};
 if(!versions[body.runtime].includes(body.version))return c.json({error:"UNSUPPORTED_RUNTIME_VERSION"},400);
 const account=await c.env.DB.prepare("SELECT id FROM users WHERE telegram_id=? AND status='active'").bind(user.id).first<{id:number}>();
 if(!account)return c.json({error:"USER_NOT_FOUND"},404);
 const plan=await c.env.DB.prepare("SELECT p.id,p.max_projects,p.max_files,p.max_upload_bytes,p.cpu_millicores,p.ram_mb,p.storage_mb,p.allowed_runtimes,p.allowed_versions FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=? AND s.status='active' AND datetime(s.expires_at)>CURRENT_TIMESTAMP ORDER BY s.id DESC LIMIT 1").bind(account.id).first<{id:number;max_projects:number;max_files:number;max_upload_bytes:number;cpu_millicores:number;ram_mb:number;storage_mb:number;allowed_runtimes:string;allowed_versions:string}>();
 if(!plan)return c.json({error:"ACTIVE_PLAN_REQUIRED"},403);
 let allowedRuntimes:string[];try{allowedRuntimes=JSON.parse(plan.allowed_runtimes);}catch{allowedRuntimes=["python","nodejs"];}
 if(!allowedRuntimes.includes(body.runtime))return c.json({error:"RUNTIME_NOT_INCLUDED"},403);
 const count=await c.env.DB.prepare("SELECT COUNT(*) AS total FROM projects WHERE user_id=? AND deleted_at IS NULL").bind(account.id).first<{total:number}>();
 if((count?.total||0)>=plan.max_projects)return c.json({error:"PROJECT_LIMIT_REACHED",limit:plan.max_projects},403);
 const server=await c.env.DB.prepare("SELECT id FROM vps_servers WHERE enabled=1 AND status='healthy' ORDER BY CAST(json_extract(capacity_json,'$.memory_free_mb') AS INTEGER) DESC,id LIMIT 1").first<{id:number}>();
 if(!server)return c.json({error:"NO_HEALTHY_VPS_AVAILABLE"},503);
 const id=crypto.randomUUID();const taskId=crypto.randomUUID();
 const payload={runtime:body.runtime,version:body.version,startup_command:"sleep infinity",cpu_millicores:Math.min(Math.max(plan.cpu_millicores,100),4000),ram_mb:Math.min(Math.max(plan.ram_mb,128),8192),pids_limit:128};
 await c.env.DB.batch([
  c.env.DB.prepare("INSERT INTO projects(id,user_id,server_id,name,runtime,runtime_version,status,startup_command,resource_limits_json) VALUES(?,?,?,?,?,?,'queued',?,?)").bind(id,account.id,server.id,body.name.trim(),body.runtime,body.version,payload.startup_command,JSON.stringify({cpu_millicores:payload.cpu_millicores,ram_mb:payload.ram_mb,storage_mb:plan.storage_mb,max_files:plan.max_files,max_upload_bytes:plan.max_upload_bytes})),
  c.env.DB.prepare("INSERT INTO agent_tasks(id,server_id,project_id,action,payload_json) VALUES(?,?,?,'create',?)").bind(taskId,server.id,id,JSON.stringify(payload))
 ]);
 return c.json({ok:true,project:{id,name:body.name.trim(),runtime:body.runtime,version:body.version,status:"queued"},task_id:taskId},202);
});

app.post("/api/projects/:id/control",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const projectId=c.req.param("id");const body=await c.req.json<{action:string;path?:string;content_base64?:string;offset?:number;length?:number}>().catch(()=>null);
 const allowed=["start","stop","restart","logs","file_list","file_read","file_write","file_delete","file_mkdir"];
 if(!body||!allowed.includes(body.action))return c.json({error:"INVALID_PROJECT_ACTION"},400);
 const project=await c.env.DB.prepare("SELECT p.id,p.server_id,p.user_id,p.runtime,p.runtime_version,p.resource_limits_json,p.startup_command FROM projects p JOIN users u ON u.id=p.user_id WHERE p.id=? AND u.telegram_id=? AND p.deleted_at IS NULL").bind(projectId,user.id).first<any>();
 if(!project)return c.json({error:"PROJECT_NOT_FOUND"},404);
 if(body.path!==undefined&&(typeof body.path!=="string"||body.path.length>512||body.path.startsWith("/")||body.path.split("/").some((x:string)=>x===".."||x===".")))return c.json({error:"INVALID_FILE_PATH"},400);
 if(body.action==="file_write"&&(typeof body.content_base64!=="string"||body.content_base64.length>90000))return c.json({error:"FILE_CONTENT_TOO_LARGE"},413);
 const queueAction=["start","stop","restart"].includes(body.action)?body.action:"restart";
 const taskId=crypto.randomUUID();let limits:any={};try{limits=JSON.parse(project.resource_limits_json||"{}");}catch{}
 const payload={control_action:body.action,path:body.path||"",content_base64:body.content_base64||"",offset:Number.isSafeInteger(body.offset)?body.offset:undefined,length:Number.isSafeInteger(body.length)?body.length:undefined,runtime:project.runtime,version:project.runtime_version,startup_command:project.startup_command||"sleep infinity",cpu_millicores:limits.cpu_millicores||500,ram_mb:limits.ram_mb||512,max_files:limits.max_files||100,storage_mb:limits.storage_mb||512,pids_limit:128};
 await c.env.DB.prepare("INSERT INTO agent_tasks(id,server_id,project_id,action,payload_json) VALUES(?,?,?,?,?)").bind(taskId,project.server_id,projectId,queueAction,JSON.stringify(payload)).run();
 return c.json({ok:true,task_id:taskId,status:"queued"},202);
});
app.get("/api/projects/:id/tasks/:task_id",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const row=await c.env.DB.prepare("SELECT t.id,t.status,t.result_json,t.error,t.created_at FROM agent_tasks t JOIN projects p ON p.id=t.project_id JOIN users u ON u.id=p.user_id WHERE t.id=? AND p.id=? AND u.telegram_id=?").bind(c.req.param("task_id"),c.req.param("id"),user.id).first<any>();
 if(!row)return c.json({error:"TASK_NOT_FOUND"},404);
 let result=null;try{result=row.result_json?JSON.parse(row.result_json):null;}catch{}
 return c.json({task:{id:row.id,status:row.status,result,error:row.error,created_at:row.created_at}});
});


app.post("/api/projects/:id/github-backup",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const body=await c.req.json<{repository:string;branch?:string;action?:"backup"|"restore"}>().catch(()=>null);
 const repository=String(body?.repository||"").trim(),branch=String(body?.branch||"hostpilot-backup").trim(),action=body?.action==="restore"?"github_restore":"github_backup";
 if(!body||!/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)||!/^[-A-Za-z0-9._/]{1,100}$/.test(branch)||branch.includes(".."))return c.json({error:"INVALID_GITHUB_REPOSITORY_OR_BRANCH"},400);
 const project=await c.env.DB.prepare("SELECT p.id,p.server_id FROM projects p JOIN users u ON u.id=p.user_id WHERE p.id=? AND u.telegram_id=? AND p.deleted_at IS NULL").bind(c.req.param("id"),user.id).first<any>();
 if(!project)return c.json({error:"PROJECT_NOT_FOUND"},404);
 const pending=await c.env.DB.prepare("SELECT id FROM agent_tasks WHERE project_id=? AND status IN ('queued','leased') LIMIT 1").bind(project.id).first();
 if(pending)return c.json({error:"PROJECT_TASK_IN_PROGRESS"},409);
 const taskId=crypto.randomUUID();
 await c.env.DB.prepare("INSERT INTO agent_tasks(id,server_id,project_id,action,payload_json) VALUES(?,?,?,'restart',?)").bind(taskId,project.server_id,project.id,JSON.stringify({control_action:action,repository,branch})).run();
 return c.json({ok:true,task_id:taskId,status:"queued",repository,branch,action},202);
});
app.get("/api/projects/:id/backups",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const project=await c.env.DB.prepare("SELECT p.id FROM projects p JOIN users u ON u.id=p.user_id WHERE p.id=? AND u.telegram_id=? AND p.deleted_at IS NULL").bind(c.req.param("id"),user.id).first();
 if(!project)return c.json({error:"PROJECT_NOT_FOUND"},404);
 const rows=await c.env.DB.prepare("SELECT id,size_bytes,status,created_at,expires_at FROM backups WHERE project_id=? ORDER BY created_at DESC LIMIT 10").bind(c.req.param("id")).all();
 return c.json({backups:rows.results||[]});
});
app.post("/api/projects/:id/backups",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const project=await c.env.DB.prepare("SELECT p.id,p.user_id,p.server_id FROM projects p JOIN users u ON u.id=p.user_id WHERE p.id=? AND u.telegram_id=? AND p.deleted_at IS NULL").bind(c.req.param("id"),user.id).first<any>();
 if(!project)return c.json({error:"PROJECT_NOT_FOUND"},404);
 const active=await c.env.DB.prepare("SELECT id FROM subscriptions WHERE user_id=? AND status='active' AND datetime(expires_at)>CURRENT_TIMESTAMP").bind(project.user_id).first();
 if(!active)return c.json({error:"ACTIVE_PLAN_REQUIRED"},403);
 const pending=await c.env.DB.prepare("SELECT id FROM backups WHERE project_id=? AND status IN ('queued','running','restoring') LIMIT 1").bind(project.id).first();
 if(pending)return c.json({error:"BACKUP_TASK_ALREADY_RUNNING"},409);
 const count=await c.env.DB.prepare("SELECT COUNT(*) AS total FROM backups WHERE project_id=? AND status='completed'").bind(project.id).first<any>();
 if(Number(count?.total||0)>=5)return c.json({error:"BACKUP_RETENTION_LIMIT",limit:5},409);
 const backupId=crypto.randomUUID(),taskId=crypto.randomUUID();
 await c.env.DB.batch([
  c.env.DB.prepare("INSERT INTO backups(id,project_id,server_id,storage_path,size_bytes,status,expires_at) VALUES(?,?,?,?,0,'queued',datetime('now','+30 days'))").bind(backupId,project.id,project.server_id,backupId),
  c.env.DB.prepare("INSERT INTO agent_tasks(id,server_id,project_id,action,payload_json) VALUES(?,?,?,'restart',?)").bind(taskId,project.server_id,project.id,JSON.stringify({control_action:"backup",backup_action:"create",backup_id:backupId}))
 ]);
 return c.json({ok:true,backup_id:backupId,task_id:taskId,status:"queued"},202);
});
app.post("/api/projects/:id/backups/:backup_id/restore",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const project=await c.env.DB.prepare("SELECT p.id,p.server_id FROM projects p JOIN users u ON u.id=p.user_id WHERE p.id=? AND u.telegram_id=? AND p.deleted_at IS NULL").bind(c.req.param("id"),user.id).first<any>();
 if(!project)return c.json({error:"PROJECT_NOT_FOUND"},404);
 const backup=await c.env.DB.prepare("SELECT id,status FROM backups WHERE id=? AND project_id=? AND server_id=?").bind(c.req.param("backup_id"),project.id,project.server_id).first<any>();
 if(!backup||backup.status!=="completed")return c.json({error:"BACKUP_NOT_RESTORABLE"},404);
 const pending=await c.env.DB.prepare("SELECT id FROM agent_tasks WHERE project_id=? AND status IN ('queued','leased') LIMIT 1").bind(project.id).first();
 if(pending)return c.json({error:"PROJECT_TASK_IN_PROGRESS"},409);
 const taskId=crypto.randomUUID();
 await c.env.DB.prepare("INSERT INTO agent_tasks(id,server_id,project_id,action,payload_json) VALUES(?,?,?,'restart',?)").bind(taskId,project.server_id,project.id,JSON.stringify({control_action:"backup",backup_action:"restore",backup_id:backup.id})).run();
 return c.json({ok:true,task_id:taskId,status:"queued"},202);
});

app.post("/api/projects/:id/files/upload/init",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const projectId=c.req.param("id");if(!/^[a-f0-9-]{36}$/i.test(projectId))return c.json({error:"INVALID_PROJECT_ID"},400);
 const body=await c.req.json<{path:string;size_bytes:number}>().catch(()=>null);
 if(!body||typeof body.path!=="string"||!body.path.trim()||body.path.length>512||body.path.startsWith("/")||body.path.split("/").some(part=>!part||part==="."||part==="..")||!Number.isSafeInteger(body.size_bytes)||body.size_bytes<1)return c.json({error:"INVALID_FILE_UPLOAD"},400);
 const project=await c.env.DB.prepare("SELECT p.id,p.user_id,p.server_id,p.resource_limits_json FROM projects p JOIN users u ON u.id=p.user_id WHERE p.id=? AND u.telegram_id=? AND p.deleted_at IS NULL").bind(projectId,user.id).first<any>();
 if(!project)return c.json({error:"PROJECT_NOT_FOUND"},404);
 const plan=await c.env.DB.prepare("SELECT p.max_file_bytes,p.max_files,p.storage_mb FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=? AND s.status='active' AND datetime(s.expires_at)>CURRENT_TIMESTAMP ORDER BY s.id DESC LIMIT 1").bind(project.user_id).first<any>();
 if(!plan)return c.json({error:"ACTIVE_PLAN_REQUIRED"},403);
 const maxBytes=Math.max(1,Math.min(500*1024*1024,Number(plan.max_file_bytes||10*1024*1024)));
 if(body.size_bytes>maxBytes)return c.json({error:"PLAN_FILE_SIZE_LIMIT",max_bytes:maxBytes},413);
 const chunkSize=256*1024,chunkCount=Math.ceil(body.size_bytes/chunkSize);
 if(chunkCount>2048)return c.json({error:"FILE_CHUNK_LIMIT"},413);
 const uploadId=crypto.randomUUID();
 const cleanPath=body.path.split("/").map(part=>part.replace(/[^A-Za-z0-9._ -]/g,"_").slice(0,120)).join("/");
 await c.env.DB.prepare("INSERT INTO project_uploads(id,project_id,user_id,filename,size_bytes,chunk_count,status,detected_json) VALUES(?,?,?,?,?,?,'receiving',?)")
  .bind(uploadId,projectId,project.user_id,cleanPath.split("/").pop()||"upload.bin",body.size_bytes,chunkCount,JSON.stringify({kind:"file",path:cleanPath})).run();
 return c.json({ok:true,upload_id:uploadId,chunk_size:chunkSize,chunk_count:chunkCount,max_bytes:maxBytes},201);
});
app.put("/api/projects/:id/files/upload/:upload_id/chunks/:index",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const upload=await c.env.DB.prepare("SELECT u.id,u.size_bytes,u.chunk_count,u.status FROM project_uploads u JOIN projects p ON p.id=u.project_id JOIN users a ON a.id=p.user_id WHERE u.id=? AND p.id=? AND a.telegram_id=? AND p.deleted_at IS NULL").bind(c.req.param("upload_id"),c.req.param("id"),user.id).first<any>();
 if(!upload||upload.status!=="receiving")return c.json({error:"UPLOAD_NOT_FOUND_OR_CLOSED"},404);
 const index=Number(c.req.param("index"));if(!Number.isInteger(index)||index<0||index>=upload.chunk_count)return c.json({error:"INVALID_CHUNK_INDEX"},400);
 const body=await c.req.json<{chunk_base64:string}>().catch(()=>null);
 if(!body||typeof body.chunk_base64!=="string"||body.chunk_base64.length>350000)return c.json({error:"INVALID_UPLOAD_CHUNK"},413);
 let binary:string;try{binary=atob(body.chunk_base64);}catch{return c.json({error:"INVALID_CHUNK_ENCODING"},400);}
 const expected=Math.min(256*1024,upload.size_bytes-index*256*1024);
 if(binary.length!==expected)return c.json({error:"INVALID_CHUNK_SIZE",expected_bytes:expected},400);
 const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 await c.env.DB.prepare("INSERT INTO project_upload_chunks(upload_id,chunk_index,chunk_data) VALUES(?,?,?) ON CONFLICT(upload_id,chunk_index) DO UPDATE SET chunk_data=excluded.chunk_data").bind(upload.id,index,bytes.buffer).run();
 return c.json({ok:true,index,received_bytes:bytes.length});
});
app.post("/api/projects/:id/files/upload/:upload_id/complete",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const project=await c.env.DB.prepare("SELECT p.id,p.user_id,p.server_id,p.resource_limits_json FROM projects p JOIN users u ON u.id=p.user_id WHERE p.id=? AND u.telegram_id=? AND p.deleted_at IS NULL").bind(c.req.param("id"),user.id).first<any>();
 if(!project)return c.json({error:"PROJECT_NOT_FOUND"},404);
 const upload=await c.env.DB.prepare("SELECT id,size_bytes,chunk_count,status,detected_json FROM project_uploads WHERE id=? AND project_id=? AND user_id=?").bind(c.req.param("upload_id"),project.id,project.user_id).first<any>();
 if(!upload||upload.status!=="receiving")return c.json({error:"UPLOAD_NOT_FOUND_OR_CLOSED"},404);
 const count=await c.env.DB.prepare("SELECT COUNT(*) AS count FROM project_upload_chunks WHERE upload_id=?").bind(upload.id).first<{count:number}>();
 if(Number(count?.count||0)!==Number(upload.chunk_count))return c.json({error:"UPLOAD_INCOMPLETE",received_chunks:Number(count?.count||0),expected_chunks:upload.chunk_count},409);
 const plan=await c.env.DB.prepare("SELECT p.max_file_bytes,p.max_files,p.storage_mb FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=? AND s.status='active' AND datetime(s.expires_at)>CURRENT_TIMESTAMP ORDER BY s.id DESC LIMIT 1").bind(project.user_id).first<any>();
 if(!plan||upload.size_bytes>Number(plan.max_file_bytes||10*1024*1024))return c.json({error:"PLAN_FILE_SIZE_LIMIT"},403);
 let metadata:any={};try{metadata=JSON.parse(upload.detected_json||"{}");}catch{}
 if(metadata.kind!=="file"||typeof metadata.path!=="string")return c.json({error:"UPLOAD_METADATA_INVALID"},400);
 let resources:any={};try{resources=JSON.parse(project.resource_limits_json||"{}");}catch{}
 const taskId=crypto.randomUUID(),payload={upload_id:upload.id,file_upload:true,control_action:"file_upload",path:metadata.path,max_file_bytes:Number(plan.max_file_bytes),max_files:Number(plan.max_files||resources.max_files||100),storage_mb:Number(plan.storage_mb||resources.storage_mb||512)};
 await c.env.DB.batch([
  c.env.DB.prepare("UPDATE project_uploads SET status='queued' WHERE id=? AND status='receiving'").bind(upload.id),
  c.env.DB.prepare("INSERT INTO agent_tasks(id,server_id,project_id,action,payload_json) VALUES(?,?,?,'restart',?)").bind(taskId,project.server_id,project.id,JSON.stringify(payload))
 ]);
 return c.json({ok:true,upload_id:upload.id,task_id:taskId,status:"queued"},202);
});

app.post("/api/projects/:id/upload",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const projectId=c.req.param("id");if(!/^[a-f0-9-]{36}$/i.test(projectId))return c.json({error:"INVALID_PROJECT_ID"},400);
 const project=await c.env.DB.prepare("SELECT p.id,p.server_id,p.runtime,p.runtime_version,p.user_id,p.resource_limits_json FROM projects p JOIN users u ON u.id=p.user_id WHERE p.id=? AND u.telegram_id=? AND p.deleted_at IS NULL").bind(projectId,user.id).first<{id:string;server_id:number;runtime:string;runtime_version:string;user_id:number;resource_limits_json:string}>();
 if(!project)return c.json({error:"PROJECT_NOT_FOUND"},404);
 const plan=await c.env.DB.prepare("SELECT p.max_upload_bytes FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=? AND s.status='active' AND datetime(s.expires_at)>CURRENT_TIMESTAMP ORDER BY s.id DESC LIMIT 1").bind(project.user_id).first<{max_upload_bytes:number}>();
 if(!plan)return c.json({error:"ACTIVE_PLAN_REQUIRED"},403);
 const form=await c.req.formData().catch(()=>null);const file=form?.get("archive");
 if(!file||typeof file==="string"||!file.name.toLowerCase().endsWith(".zip"))return c.json({error:"ZIP_FILE_REQUIRED"},400);
 const limit=Math.min(plan.max_upload_bytes,20*1024*1024);if(file.size<4||file.size>limit)return c.json({error:"UPLOAD_SIZE_LIMIT",max_bytes:limit},413);
 const bytes=new Uint8Array(await file.arrayBuffer());if(bytes[0]!==0x50||bytes[1]!==0x4b||![0x03,0x05,0x07].includes(bytes[2]))return c.json({error:"INVALID_ZIP_ARCHIVE"},400);
 const uploadId=crypto.randomUUID();const chunkSize=256*1024;const chunkCount=Math.ceil(bytes.length/chunkSize);const cleanName=file.name.replace(/[^A-Za-z0-9._-]/g,"_").slice(0,120)||"project.zip";
 const statements=[c.env.DB.prepare("INSERT INTO project_uploads(id,project_id,user_id,filename,size_bytes,chunk_count,status) VALUES(?,?,?,?,?,?,'queued')").bind(uploadId,projectId,project.user_id,cleanName,bytes.length,chunkCount)];
 for(let i=0;i<chunkCount;i++){const chunk=bytes.slice(i*chunkSize,Math.min(bytes.length,(i+1)*chunkSize));statements.push(c.env.DB.prepare("INSERT INTO project_upload_chunks(upload_id,chunk_index,chunk_data) VALUES(?,?,?)").bind(uploadId,i,chunk.buffer.slice(chunk.byteOffset,chunk.byteOffset+chunk.byteLength)));}
 await c.env.DB.batch(statements);const taskId=crypto.randomUUID();let resources:any={};try{resources=JSON.parse(project.resource_limits_json||"{}");}catch{}const payload={upload_id:uploadId,runtime:project.runtime,version:project.runtime_version,cpu_millicores:resources.cpu_millicores||500,ram_mb:resources.ram_mb||512,max_files:resources.max_files||500,storage_mb:resources.storage_mb||100,pids_limit:128};
 await c.env.DB.prepare("INSERT INTO agent_tasks(id,server_id,project_id,action,payload_json) VALUES(?,?,?,'create',?)").bind(taskId,project.server_id,projectId,JSON.stringify(payload)).run();
 return c.json({ok:true,upload_id:uploadId,task_id:taskId,size_bytes:bytes.length,status:"queued"},202);
});
app.get("/api/agent/uploads/:id",async c=>{
 const token=(c.req.header("Authorization")||"").replace(/^Bearer /,"");if(token.length<32)return c.json({error:"UNAUTHORIZED"},401);const hash=await sha256Hex(token);
 const node=await c.env.DB.prepare("SELECT id,enabled FROM vps_servers WHERE agent_token_hash=?").bind(hash).first<{id:number;enabled:number}>();if(!node||!node.enabled)return c.json({error:"UNAUTHORIZED"},401);
 const upload=await c.env.DB.prepare("SELECT u.id,u.filename,u.size_bytes,u.chunk_count,u.project_id,u.detected_json,u.status,p.runtime,p.runtime_version FROM project_uploads u JOIN projects p ON p.id=u.project_id WHERE u.id=? AND p.server_id=? AND p.deleted_at IS NULL").bind(c.req.param("id"),node.id).first<any>();
 if(!upload)return c.json({error:"UPLOAD_NOT_FOUND"},404);return c.json({upload});
});
app.get("/api/agent/uploads/:id/chunks/:index",async c=>{
 const token=(c.req.header("Authorization")||"").replace(/^Bearer /,"");if(token.length<32)return c.json({error:"UNAUTHORIZED"},401);const hash=await sha256Hex(token);
 const node=await c.env.DB.prepare("SELECT id,enabled FROM vps_servers WHERE agent_token_hash=?").bind(hash).first<{id:number;enabled:number}>();if(!node||!node.enabled)return c.json({error:"UNAUTHORIZED"},401);
 const index=Number(c.req.param("index"));if(!Number.isInteger(index)||index<0)return c.json({error:"INVALID_CHUNK_INDEX"},400);
 const row=await c.env.DB.prepare("SELECT ch.chunk_data FROM project_upload_chunks ch JOIN project_uploads u ON u.id=ch.upload_id JOIN projects p ON p.id=u.project_id WHERE ch.upload_id=? AND ch.chunk_index=? AND p.server_id=?").bind(c.req.param("id"),index,node.id).first<{chunk_data:ArrayBuffer}>();
 if(!row)return c.json({error:"UPLOAD_CHUNK_NOT_FOUND"},404);return new Response(row.chunk_data,{headers:{"content-type":"application/octet-stream","cache-control":"no-store"}});
});

app.get("/api/agent/tasks",async c=>{
 const token=(c.req.header("Authorization")||"").replace(/^Bearer /,"");if(token.length<32)return c.json({error:"UNAUTHORIZED"},401);
 const hash=await sha256Hex(token);const node=await c.env.DB.prepare("SELECT id,enabled FROM vps_servers WHERE agent_token_hash=?").bind(hash).first<{id:number;enabled:number}>();
 if(!node||!node.enabled)return c.json({error:"UNAUTHORIZED"},401);
 await c.env.DB.prepare("UPDATE agent_tasks SET status='queued',lease_token=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE server_id=? AND status='leased' AND datetime(lease_expires_at)<=CURRENT_TIMESTAMP").bind(node.id).run();
 const candidate=await c.env.DB.prepare("SELECT id FROM agent_tasks WHERE server_id=? AND status='queued' ORDER BY created_at LIMIT 1").bind(node.id).first<{id:string}>();
 if(!candidate)return c.json({task:null});
 const lease=crypto.randomUUID();
 const claimed=await c.env.DB.prepare("UPDATE agent_tasks SET status='leased',lease_token=?,lease_expires_at=datetime('now','+15 minutes'),attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND server_id=? AND status='queued'").bind(lease,candidate.id,node.id).run();
 if(!claimed.meta.changes)return c.json({task:null});
 const task=await c.env.DB.prepare("SELECT id,project_id,action,payload_json,lease_token FROM agent_tasks WHERE id=? AND server_id=?").bind(candidate.id,node.id).first<any>();
 return c.json({task});
});
app.post("/api/agent/tasks/:id/result",async c=>{
 const token=(c.req.header("Authorization")||"").replace(/^Bearer /,"");if(token.length<32)return c.json({error:"UNAUTHORIZED"},401);
 const hash=await sha256Hex(token);const node=await c.env.DB.prepare("SELECT id,enabled FROM vps_servers WHERE agent_token_hash=?").bind(hash).first<{id:number;enabled:number}>();
 if(!node||!node.enabled)return c.json({error:"UNAUTHORIZED"},401);
 const body=await c.req.json<{lease_token:string;ok:boolean;result?:unknown;error?:string}>().catch(()=>null);
 if(!body||typeof body.lease_token!=="string"||typeof body.ok!=="boolean")return c.json({error:"INVALID_RESULT"},400);
 const task=await c.env.DB.prepare("SELECT project_id,action,payload_json FROM agent_tasks WHERE id=? AND server_id=? AND status='leased' AND lease_token=?").bind(c.req.param("id"),node.id,body.lease_token).first<{project_id:string|null;action:string;payload_json:string}>();
 if(!task)return c.json({error:"TASK_LEASE_INVALID"},409);
 const status=body.ok?"succeeded":"failed";
 const taskPayload=JSON.parse(task.payload_json||"{}");
 const statements:any[]=[
  c.env.DB.prepare("UPDATE agent_tasks SET status=?,result_json=?,error=?,lease_token=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lease_token=?").bind(status,JSON.stringify(body.result??null).slice(0,120000),String(body.error||"").slice(0,1000)||null,c.req.param("id"),body.lease_token)
 ];
 if(task.project_id&&(!taskPayload.control_action||["start","stop","restart"].includes(taskPayload.control_action))){
  statements.push(c.env.DB.prepare("UPDATE projects SET status=?,entry_file=COALESCE(?,entry_file),startup_command=COALESCE(?,startup_command),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(body.ok?(task.action==="delete"?"deleted":task.action==="stop"?"stopped":"running"):"failed",body.ok&&body.result&&typeof body.result==="object"?(body.result as any).entry_file||null:null,body.ok&&body.result&&typeof body.result==="object"?(body.result as any).startup_command||null:null,task.project_id));
 }
 if(taskPayload.backup_id&&taskPayload.backup_action==="delete"){
  statements.push(c.env.DB.prepare("UPDATE backups SET status=? WHERE id=? AND project_id=?").bind(body.ok?"deleted":"failed",taskPayload.backup_id,task.project_id));
 }
 if(taskPayload.backup_id&&taskPayload.backup_action==="create"){
  const backupResult=body.result&&typeof body.result==="object"?body.result as any:{};
  statements.push(c.env.DB.prepare("UPDATE backups SET status=?,size_bytes=?,storage_path=? WHERE id=? AND project_id=?").bind(body.ok?"completed":"failed",body.ok?Math.max(0,Number(backupResult.size_bytes||0)):0,String(taskPayload.backup_id),taskPayload.backup_id,task.project_id));
 }
 if(taskPayload.upload_id){
  statements.push(c.env.DB.prepare("UPDATE project_uploads SET status=?,detected_json=? WHERE id=?").bind(body.ok?(taskPayload.file_upload?"uploaded":"deployed"):"failed",JSON.stringify(body.result||{error:body.error||"UPLOAD_FAILED"}).slice(0,12000),taskPayload.upload_id));
  statements.push(c.env.DB.prepare("DELETE FROM project_upload_chunks WHERE upload_id=?").bind(taskPayload.upload_id));
 }
 await c.env.DB.batch(statements);
 return c.json({ok:true,status});
});

app.get("/api/admin/servers",async c=>{
  const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
  const rows=await c.env.DB.prepare("SELECT id,name,provider,region,endpoint,ssh_host,ssh_port,status,capacity_json,agent_version,last_heartbeat_at,enabled,last_error,created_at FROM vps_servers ORDER BY id DESC").all();
  return c.json({servers:rows.results||[]});
});
app.post("/api/admin/servers",async c=>{
  const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
  const body=await c.req.json<{name:string;provider?:string;region?:string;endpoint?:string;ssh_host?:string;ssh_port?:number}>().catch(()=>null);
  if(!body||typeof body.name!=="string"||body.name.trim().length<2||body.name.length>80)return c.json({error:"INVALID_SERVER"},400);
  const provider=String(body.provider||"custom").trim().slice(0,60);
  const region=String(body.region||"").trim().slice(0,80)||null;
  const endpoint=String(body.endpoint||"").trim();
  if(endpoint&&!endpoint.startsWith("https://"))return c.json({error:"ENDPOINT_MUST_USE_HTTPS"},400);
  const sshHost=String(body.ssh_host||"").trim().slice(0,253)||null;const sshPort=body.ssh_port===undefined?2222:Number(body.ssh_port);
  if(sshHost&&!/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])$/.test(sshHost))return c.json({error:"INVALID_SSH_HOST"},400);
  if(!Number.isInteger(sshPort)||sshPort<1||sshPort>65535)return c.json({error:"INVALID_SSH_PORT"},400);
  const token=crypto.randomUUID().replace(/-/g,"")+crypto.randomUUID().replace(/-/g,"");
  const hash=await sha256Hex(token);
  const result=await c.env.DB.prepare("INSERT INTO vps_servers(name,provider,region,endpoint,ssh_host,ssh_port,status,capacity_json,agent_token_hash,enabled) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(body.name.trim(),provider,region,endpoint,sshHost,sshPort,"pending","{}",hash,1).run();
  const serverId=Number(result.meta.last_row_id);
  await c.env.DB.prepare("INSERT INTO audit_logs(staff_telegram_id,action,target_type,target_id,metadata_json,result) VALUES(?,?,?,?,?,?)")
    .bind(admin.id,"server.register","vps_server",String(serverId),JSON.stringify({name:body.name,provider,region}),"success").run();
  return c.json({ok:true,server_id:serverId,agent_token:token,warning:"Copy this token now. It is shown only once."},201);
});

async function terminalEntitlement(db:D1Database,telegramId:number){
  const row=await db.prepare(`SELECT u.id,u.terminal_override,s.status AS subscription_status,p.slug AS plan_slug,
    COALESCE(p.terminal_enabled,0) AS plan_terminal_enabled
    FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id AND s.status='active' AND datetime(s.expires_at)>CURRENT_TIMESTAMP
    LEFT JOIN plans p ON p.id=s.plan_id
    WHERE u.telegram_id=? ORDER BY s.id DESC LIMIT 1`).bind(telegramId)
    .first<{id:number;terminal_override:number|null;subscription_status:string|null;plan_slug:string|null;plan_terminal_enabled:number}>();
  if(!row)return {allowed:false,source:"none",reason:"USER_NOT_FOUND"};
  const allowed=row.terminal_override===1?true:row.terminal_override===0?false:row.plan_terminal_enabled===1;
  return {allowed,source:row.terminal_override===null?"plan":"admin_override",
    plan:row.plan_slug||"free",reason:allowed?"ENABLED":"TERMINAL_NOT_INCLUDED"};
}
app.get("/api/terminal/projects",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const access=await terminalEntitlement(c.env.DB,user.id);if(!access.allowed)return c.json({error:"TERMINAL_NOT_INCLUDED"},403);
 const rows=await c.env.DB.prepare("SELECT p.id,p.name,p.status,v.name AS server_name,v.ssh_host,v.ssh_port,(SELECT fingerprint FROM terminal_ssh_keys k WHERE k.project_id=p.id AND k.user_id=p.user_id AND k.revoked_at IS NULL) AS fingerprint FROM projects p JOIN users u ON u.id=p.user_id LEFT JOIN vps_servers v ON v.id=p.server_id WHERE u.telegram_id=? AND p.deleted_at IS NULL ORDER BY p.created_at DESC").bind(user.id).all();
 return c.json({projects:(rows.results||[]).map((p:any)=>({...p,ssh_username:"hp_"+String(p.id).replace(/-/g,"")}))});
});
app.post("/api/terminal/projects/:id/key",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const access=await terminalEntitlement(c.env.DB,user.id);if(!access.allowed)return c.json({error:"TERMINAL_NOT_INCLUDED"},403);
 const projectId=c.req.param("id");if(!/^[a-f0-9-]{36}$/i.test(projectId))return c.json({error:"INVALID_PROJECT_ID"},400);
 const body=await c.req.json<{public_key:string}>().catch(()=>null);if(!body||typeof body.public_key!=="string"||body.public_key.length>16384)return c.json({error:"INVALID_PUBLIC_KEY"},400);
 const parts=body.public_key.trim().split(/\s+/);const keyType=parts[0],blob=parts[1];
 if(!["ssh-ed25519","ecdsa-sha2-nistp256"].includes(keyType)||!blob||!/^[A-Za-z0-9+/]+={0,2}$/.test(blob))return c.json({error:"USE_ED25519_OR_ECDSA_PUBLIC_KEY"},400);
 let decoded:Uint8Array;try{decoded=Uint8Array.from(atob(blob),ch=>ch.charCodeAt(0));}catch{return c.json({error:"INVALID_PUBLIC_KEY"},400);}
 if(decoded.length<32||decoded.length>8192||btoa(String.fromCharCode(...decoded))!==blob)return c.json({error:"INVALID_PUBLIC_KEY"},400);
 const project=await c.env.DB.prepare("SELECT p.id,p.user_id,p.server_id FROM projects p JOIN users u ON u.id=p.user_id WHERE p.id=? AND u.telegram_id=? AND p.deleted_at IS NULL").bind(projectId,user.id).first<{id:string;user_id:number;server_id:number|null}>();
 if(!project)return c.json({error:"PROJECT_NOT_FOUND"},404);if(!project.server_id)return c.json({error:"PROJECT_NOT_ASSIGNED_TO_VPS"},409);
 const server=await c.env.DB.prepare("SELECT ssh_host,ssh_port,enabled FROM vps_servers WHERE id=?").bind(project.server_id).first<{ssh_host:string|null;ssh_port:number;enabled:number}>();
 if(!server||!server.enabled||!server.ssh_host)return c.json({error:"SSH_ENDPOINT_NOT_CONFIGURED"},409);
 const keyBytes=new ArrayBuffer(decoded.length);new Uint8Array(keyBytes).set(decoded);const digest=await crypto.subtle.digest("SHA-256",keyBytes);const fingerprint="SHA256:"+btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/=+$/,"");
 const previousKey=await c.env.DB.prepare("SELECT fingerprint FROM terminal_ssh_keys WHERE project_id=? AND user_id=? AND revoked_at IS NULL").bind(projectId,project.user_id).first<{fingerprint:string}>();
 await c.env.DB.prepare("INSERT INTO terminal_ssh_keys(project_id,user_id,key_type,key_blob,fingerprint,revoked_at) VALUES(?,?,?,?,?,NULL) ON CONFLICT(project_id,user_id) DO UPDATE SET key_type=excluded.key_type,key_blob=excluded.key_blob,fingerprint=excluded.fingerprint,created_at=CURRENT_TIMESTAMP,revoked_at=NULL").bind(projectId,project.user_id,keyType,blob,fingerprint).run();
 await c.env.DB.prepare("INSERT INTO terminal_ssh_key_events(project_id,user_id,action,fingerprint) VALUES(?,?,?,?)").bind(projectId,project.user_id,previousKey?"rotated":"registered",fingerprint).run();
 return c.json({ok:true,fingerprint,ssh_host:server.ssh_host,ssh_port:server.ssh_port,ssh_username:"hp_"+projectId.replace(/-/g,"")});
});
app.delete("/api/terminal/projects/:id/key",async c=>{
 const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);if(!user)return c.json({error:"UNAUTHORIZED"},401);
 const access=await terminalEntitlement(c.env.DB,user.id);if(!access.allowed)return c.json({error:"TERMINAL_NOT_INCLUDED"},403);
 const oldKey=await c.env.DB.prepare("SELECT k.user_id,k.fingerprint FROM terminal_ssh_keys k JOIN users u ON u.id=k.user_id WHERE k.project_id=? AND u.telegram_id=? AND k.revoked_at IS NULL").bind(c.req.param("id"),user.id).first<{user_id:number;fingerprint:string}>();
 const result=await c.env.DB.prepare("UPDATE terminal_ssh_keys SET revoked_at=CURRENT_TIMESTAMP WHERE project_id=? AND user_id=(SELECT id FROM users WHERE telegram_id=?) AND revoked_at IS NULL").bind(c.req.param("id"),user.id).run();
 if(oldKey&&(result.meta.changes||0)>0)await c.env.DB.prepare("INSERT INTO terminal_ssh_key_events(project_id,user_id,action,fingerprint) VALUES(?,?,?,?)").bind(c.req.param("id"),oldKey.user_id,"revoked",oldKey.fingerprint).run();
 return c.json({ok:true,revoked:result.meta.changes||0});
});
app.get("/api/agent/terminal/keys",async c=>{
 const token=(c.req.header("Authorization")||"").replace(/^Bearer /,"");if(token.length<32)return c.json({error:"UNAUTHORIZED"},401);
 const hash=await sha256Hex(token);const node=await c.env.DB.prepare("SELECT id,enabled FROM vps_servers WHERE agent_token_hash=?").bind(hash).first<{id:number;enabled:number}>();if(!node||!node.enabled)return c.json({error:"UNAUTHORIZED"},401);
 const rows=await c.env.DB.prepare("SELECT k.project_id,k.key_blob FROM terminal_ssh_keys k JOIN projects p ON p.id=k.project_id JOIN users u ON u.id=k.user_id LEFT JOIN subscriptions sub ON sub.user_id=u.id AND sub.status=? AND datetime(sub.expires_at)>CURRENT_TIMESTAMP LEFT JOIN plans plan ON plan.id=sub.plan_id WHERE p.server_id=? AND p.deleted_at IS NULL AND k.revoked_at IS NULL AND (u.terminal_override=1 OR (u.terminal_override IS NULL AND plan.terminal_enabled=1))").bind("active",node.id).all();
 return c.json({keys:(rows.results||[]).map((r:any)=>({username:"hp_"+String(r.project_id).replace(/-/g,""),project_id:r.project_id,key_blob:r.key_blob}))});
});
app.get("/api/terminal/access",async c=>{
  const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);
  if(!user)return c.json({error:"UNAUTHORIZED"},401);
  return c.json(await terminalEntitlement(c.env.DB,user.id));
});

app.get("/api/admin/plans/resources",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const rows=await c.env.DB.prepare("SELECT id,name,slug,max_projects,max_files,max_upload_bytes,max_file_bytes,cpu_millicores,ram_mb,storage_mb,terminal_enabled FROM plans ORDER BY sort_order,id").all();
 return c.json({plans:rows.results||[]});
});
app.put("/api/admin/plans/:id/resources",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const id=Number(c.req.param("id"));const body=await c.req.json<any>().catch(()=>null);
 const fields=["max_projects","max_files","max_upload_bytes","max_file_bytes","cpu_millicores","ram_mb","storage_mb"];
 if(!Number.isSafeInteger(id)||id<1||!body||fields.some(key=>!Number.isSafeInteger(body[key])))return c.json({error:"INVALID_RESOURCE_LIMITS"},400);
 const ranges:any={max_projects:[1,100],max_files:[1,10000],max_upload_bytes:[1024,20*1024*1024],max_file_bytes:[1024,500*1024*1024],cpu_millicores:[100,4000],ram_mb:[128,8192],storage_mb:[128,1048576]};
 for(const key of fields)if(body[key]<ranges[key][0]||body[key]>ranges[key][1])return c.json({error:"RESOURCE_LIMIT_OUT_OF_RANGE",field:key},400);
 const result=await c.env.DB.prepare("UPDATE plans SET max_projects=?,max_files=?,max_upload_bytes=?,max_file_bytes=?,cpu_millicores=?,ram_mb=?,storage_mb=? WHERE id=?").bind(body.max_projects,body.max_files,body.max_upload_bytes,body.max_file_bytes,body.cpu_millicores,body.ram_mb,body.storage_mb,id).run();
 if(!result.meta.changes)return c.json({error:"PLAN_NOT_FOUND"},404);
 await c.env.DB.prepare("INSERT INTO audit_logs(staff_telegram_id,action,target_type,target_id,metadata_json,result) VALUES(?,?,?,?,?,?)").bind(admin.id,"plan.resource_limits","plan",String(id),JSON.stringify(body),"success").run();
 return c.json({ok:true,plan_id:id,limits:body});
});
app.get("/api/admin/terminal/plans",async c=>{
  const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
  const rows=await c.env.DB.prepare("SELECT id,name,slug,terminal_enabled FROM plans ORDER BY sort_order,id").all();
  return c.json({plans:rows.results||[]});
});
app.put("/api/admin/terminal/plans/:id",async c=>{
  const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
  const id=Number(c.req.param("id"));const body=await c.req.json<{enabled:boolean}>().catch(()=>null);
  if(!Number.isSafeInteger(id)||id<1||!body||typeof body.enabled!=="boolean")return c.json({error:"INVALID_REQUEST"},400);
  const result=await c.env.DB.prepare("UPDATE plans SET terminal_enabled=? WHERE id=?").bind(body.enabled?1:0,id).run();
  if(!result.meta.changes)return c.json({error:"PLAN_NOT_FOUND"},404);
  await c.env.DB.prepare("INSERT INTO audit_logs(staff_telegram_id,action,target_type,target_id,metadata_json,result) VALUES(?,?,?,?,?,?)")
    .bind(admin.id,"terminal.plan_access","plan",String(id),JSON.stringify({enabled:body.enabled}),"success").run();
  return c.json({ok:true,plan_id:id,terminal_enabled:body.enabled});
});
app.put("/api/admin/terminal/users/:telegram_id",async c=>{
  const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
  const telegramId=Number(c.req.param("telegram_id"));const body=await c.req.json<{enabled:boolean|null}>().catch(()=>null);
  if(!Number.isSafeInteger(telegramId)||telegramId<1||!body||!(body.enabled===true||body.enabled===false||body.enabled===null))return c.json({error:"INVALID_REQUEST"},400);
  const result=await c.env.DB.prepare("UPDATE users SET terminal_override=? WHERE telegram_id=?").bind(body.enabled===null?null:body.enabled?1:0,telegramId).run();
  if(!result.meta.changes)return c.json({error:"USER_NOT_FOUND"},404);
  await c.env.DB.prepare("INSERT INTO audit_logs(staff_telegram_id,action,target_type,target_id,metadata_json,result) VALUES(?,?,?,?,?,?)")
    .bind(admin.id,"terminal.user_override","user",String(telegramId),JSON.stringify({enabled:body.enabled}),"success").run();
  return c.json({ok:true,telegram_id:telegramId,terminal_override:body.enabled});
});

app.get("/api/admin/users",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const query=(c.req.query("q")||"").trim().slice(0,80),limit=Math.min(50,Math.max(1,Number(c.req.query("limit")||20))),offset=Math.max(0,Number(c.req.query("offset")||0));
 const pattern="%"+query+"%";
 const rows=await c.env.DB.prepare(`SELECT u.telegram_id,u.first_name,u.last_name,u.username,u.status,u.language_code,u.created_at,
 (SELECT COUNT(*) FROM projects p WHERE p.user_id=u.id AND p.deleted_at IS NULL) AS project_count,
 (SELECT pl.name FROM subscriptions s JOIN plans pl ON pl.id=s.plan_id WHERE s.user_id=u.id ORDER BY s.created_at DESC LIMIT 1) AS plan_name
 FROM users u WHERE (?='' OR CAST(u.telegram_id AS TEXT) LIKE ? OR u.username LIKE ? OR u.first_name LIKE ?) ORDER BY u.created_at DESC LIMIT ? OFFSET ?`).bind(query,pattern,pattern,pattern,limit,offset).all();
 const count=await c.env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE (?='' OR CAST(telegram_id AS TEXT) LIKE ? OR username LIKE ? OR first_name LIKE ?)").bind(query,pattern,pattern,pattern).first<any>();
 return c.json({users:rows.results||[],total:Number(count?.total||0),limit,offset});
});
app.put("/api/admin/users/:telegram_id/status",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const telegramId=Number(c.req.param("telegram_id"));const body=await c.req.json<{status:"active"|"suspended"}>().catch(()=>null);
 if(!Number.isSafeInteger(telegramId)||telegramId<1||!body||!["active","suspended"].includes(body.status))return c.json({error:"INVALID_REQUEST"},400);
 const result=await c.env.DB.prepare("UPDATE users SET status=?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").bind(body.status,telegramId).run();
 if(!result.meta.changes)return c.json({error:"USER_NOT_FOUND"},404);
 await c.env.DB.prepare("INSERT INTO audit_logs(staff_telegram_id,action,target_type,target_id,metadata_json,result) VALUES(?,?,?,?,?,?)").bind(admin.id,"user.status","user",String(telegramId),JSON.stringify({status:body.status}),"success").run();
 return c.json({ok:true,telegram_id:telegramId,status:body.status});
});
app.get("/api/admin/overview",async c=>{
  const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
  const [users,projects,payments,servers]=await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active FROM users").first(),
    c.env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed FROM projects WHERE deleted_at IS NULL").first(),
    c.env.DB.prepare("SELECT COUNT(*) pending FROM payment_requests WHERE status='pending'").first(),
    c.env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='healthy' THEN 1 ELSE 0 END) healthy FROM vps_servers").first()
  ]);
  return c.json({users,projects,payments,servers});
});
app.get("/api/admin/backups",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const rows=await c.env.DB.prepare(`SELECT b.id,b.project_id,b.server_id,b.size_bytes,b.status,b.created_at,b.expires_at,
 p.name AS project_name,u.telegram_id,u.first_name AS owner_name,v.name AS server_name
 FROM backups b JOIN projects p ON p.id=b.project_id JOIN users u ON u.id=p.user_id
 LEFT JOIN vps_servers v ON v.id=b.server_id
 ORDER BY b.created_at DESC LIMIT 100`).all();
 return c.json({backups:rows.results||[]});
});
app.post("/api/admin/backups/:id/restore",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const backupId=c.req.param("id");
 if(!/^[a-f0-9-]{36}$/i.test(backupId))return c.json({error:"INVALID_BACKUP_ID"},400);
 const backup=await c.env.DB.prepare(`SELECT b.id,b.project_id,b.server_id,b.status,p.name
 FROM backups b JOIN projects p ON p.id=b.project_id
 WHERE b.id=? AND p.deleted_at IS NULL`).bind(backupId).first<any>();
 if(!backup||backup.status!=="completed")return c.json({error:"BACKUP_NOT_RESTORABLE"},404);
 const pending=await c.env.DB.prepare("SELECT id FROM agent_tasks WHERE project_id=? AND status IN ('queued','leased') LIMIT 1").bind(backup.project_id).first();
 if(pending)return c.json({error:"PROJECT_TASK_IN_PROGRESS"},409);
 const taskId=crypto.randomUUID();
 await c.env.DB.prepare("INSERT INTO agent_tasks(id,server_id,project_id,action,payload_json) VALUES(?,?,?,'restart',?)")
  .bind(taskId,backup.server_id,backup.project_id,JSON.stringify({control_action:"backup",backup_action:"restore",backup_id:backup.id})).run();
 await c.env.DB.prepare("INSERT INTO audit_logs(staff_telegram_id,action,target_type,target_id,metadata_json,result) VALUES(?,?,?,?,?,?)")
  .bind(admin.id,"backup.restore","backup",backup.id,JSON.stringify({project_id:backup.project_id,project_name:backup.name,task_id:taskId}),"queued").run();
 return c.json({ok:true,backup_id:backup.id,task_id:taskId,status:"queued"},202);
});
app.post("/api/admin/wallet/adjust",async c=>{
  const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
  const body=await c.req.json<{telegram_id:number;amount_minor:number;currency:string;direction:"credit"|"debit";reason:string;idempotency_key:string}>().catch(()=>null);
  if(!body||!Number.isSafeInteger(body.telegram_id)||!Number.isSafeInteger(body.amount_minor)||body.amount_minor<=0||!["credit","debit"].includes(body.direction)||!body.reason?.trim()||!body.idempotency_key?.trim())return c.json({error:"INVALID_REQUEST"},400);
  const target=await c.env.DB.prepare("SELECT id FROM users WHERE telegram_id=?").bind(body.telegram_id).first<{id:number}>();
  if(!target)return c.json({error:"USER_NOT_FOUND"},404);
  try {
    const balance=await appendWalletTransaction(c.env,{userId:target.id,amountMinor:body.amount_minor,currency:body.currency,direction:body.direction,reason:body.reason.slice(0,240),referenceType:"admin_adjustment",referenceId:String(admin.id),idempotencyKey:body.idempotency_key});
    await c.env.DB.prepare("INSERT INTO audit_logs(staff_telegram_id,action,target_type,target_id,metadata_json,result) VALUES(?,?,?,?,?,?)")
      .bind(admin.id,"wallet."+body.direction,"user",String(body.telegram_id),JSON.stringify({amount_minor:body.amount_minor,currency:body.currency,reason:body.reason}),"success").run();
    return c.json({ok:true,balance});
  } catch(e) {
    const existing=await c.env.DB.prepare("SELECT id FROM wallet_transactions WHERE idempotency_key=?").bind(body.idempotency_key).first();
    if(existing)return c.json({ok:true,duplicate:true});
    return c.json({error:e instanceof Error?e.message:"LEDGER_FAILED"},400);
  }
});
app.post("/api/admin/payments/:id/review",async c=>{
  const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
  const id=c.req.param("id");const body=await c.req.json<{decision:"approve"|"reject";note?:string}>().catch(()=>null);
  if(!body||!["approve","reject"].includes(body.decision))return c.json({error:"INVALID_DECISION"},400);
  const payment=await c.env.DB.prepare("SELECT * FROM payment_requests WHERE id=?").bind(id).first<any>();
  if(!payment)return c.json({error:"PAYMENT_NOT_FOUND"},404);
  if(payment.status!=="pending")return c.json({error:"PAYMENT_ALREADY_REVIEWED",status:payment.status},409);
  if(body.decision==="reject"){
    const result=await c.env.DB.prepare("UPDATE payment_requests SET status='rejected',reviewed_by=?,review_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'")
      .bind(admin.id,String(body.note||"").slice(0,500),id).run();
    if(!result.meta.changes)return c.json({error:"PAYMENT_ALREADY_REVIEWED"},409);
  } else {
    const key="payment-credit:"+id;
    try {
      await appendWalletTransaction(c.env,{userId:payment.user_id,amountMinor:payment.amount_minor,currency:payment.currency,direction:"credit",reason:"Approved deposit",referenceType:"payment",referenceId:id,idempotencyKey:key});
    } catch(e) {
      const existing=await c.env.DB.prepare("SELECT id FROM wallet_transactions WHERE idempotency_key=?").bind(key).first();
      if(!existing)return c.json({error:e instanceof Error?e.message:"CREDIT_FAILED"},409);
    }
    await c.env.DB.prepare("UPDATE payment_requests SET reviewed_by=?,review_note=? WHERE id=? AND status='approved' AND reviewed_by IS NULL")
      .bind(admin.id,String(body.note||"").slice(0,500),id).run();
  }
  await c.env.DB.prepare("INSERT INTO audit_logs(staff_telegram_id,action,target_type,target_id,metadata_json,result) VALUES(?,?,?,?,?,?)")
    .bind(admin.id,"payment."+body.decision,"payment",id,JSON.stringify({amount_minor:payment.amount_minor,currency:payment.currency}),"success").run();
  return c.json({ok:true,status:body.decision==="approve"?"approved":"rejected"});
});
app.post("/bot",async c=>{
  const supplied=c.req.header("X-Telegram-Bot-Api-Secret-Token")||"";
  if(!constantTimeEqual(supplied,c.env.BOT_WEBHOOK_SECRET))return c.json({ok:false},401);
  const update=await c.req.json<any>().catch(()=>null);const message=update?.message;
  if(!message?.chat?.id)return c.json({ok:true});
  const from=message.from||{};
  if(from.id)await c.env.DB.prepare(`INSERT INTO users(telegram_id,first_name,last_name,username,language_code) VALUES(?,?,?,?,?)
    ON CONFLICT(telegram_id) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,username=excluded.username,updated_at=CURRENT_TIMESTAMP`)
    .bind(from.id,from.first_name||"",from.last_name||null,from.username||null,from.language_code||"en").run();
  const command=String(message.text||"").trim().split(/\\s+/)[0].split("@")[0];
  const owners=(c.env.OWNER_IDS||"").split(",").map(x=>x.trim());
  const isAdmin=owners.includes(String(from.id))||!!(await c.env.DB.prepare("SELECT telegram_id FROM administrators WHERE telegram_id=?").bind(from.id).first());
  let response="Welcome to HostPilot. Manage Python and Node.js projects from the Mini App.";
  if(command==="/help")response="HostPilot commands: /start, /language, /plans, /project, /support, /help.";
  else if(command==="/plans")response="View available hosting plans in the HostPilot Mini App.";
  else if(command==="/language")response="Change your language in the Mini App Profile.";
  else if(command==="/project")response="Your project list is available in the HostPilot Mini App.";
  else if(command==="/support")response="Open the HostPilot Mini App to contact support.";
  else if(["/admin","/stats","/broadcast","/users","/payments","/projects"].includes(command))response=isAdmin?"Open the HostPilot Admin Panel to continue.":"You are not authorized to use this command.";
  const appUrl=c.env.APP_URL||"";
  const reply:any={chat_id:message.chat.id,text:response};
  if(appUrl.startsWith("https://")&&!appUrl.includes("REPLACE_WITH"))reply.reply_markup={inline_keyboard:[[{text:"Open HostPilot",web_app:{url:appUrl}}]]};
  await fetch(`https://api.telegram.org/bot${c.env.BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(reply)});
  return c.json({ok:true});
});

const ADMIN_EXPORT_TABLES=["settings","users","plans","payment_methods","announcements","campaigns","coupons"] as const;
app.get("/api/admin/export",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const requested=c.req.query("category")||"all";
 const allowed=[...ADMIN_EXPORT_TABLES];
 if(requested!=="all"&&!allowed.includes(requested as any))return c.json({error:"INVALID_EXPORT_CATEGORY",allowed:["all",...allowed]},400);
 const tables=requested==="all"?allowed:[requested as typeof ADMIN_EXPORT_TABLES[number]];
 const data:any={format:"hostpilot-export-v1",exported_at:new Date().toISOString(),tables:{}};
 for(const table of tables){
  try{const result=await c.env.DB.prepare("SELECT * FROM "+table).all();data.tables[table]=result.results||[];}
  catch(error){return c.json({error:"EXPORT_FAILED",table,message:error instanceof Error?error.message:"DATABASE_ERROR"},500);}
 }
 await c.env.DB.prepare("INSERT INTO audit_logs(staff_telegram_id,action,target_type,target_id,metadata_json,result) VALUES(?,?,?,?,?,?)")
  .bind(admin.id,"data.export","backup",requested,JSON.stringify({tables}),"success").run();
 return c.json(data,{headers:{"Content-Disposition":"attachment; filename=hostpilot-"+requested+"-export.json","Cache-Control":"no-store"}});
});
app.post("/api/admin/import",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const body=await c.req.json<any>().catch(()=>null);
 if(!body||body.format!=="hostpilot-export-v1"||!body.tables||typeof body.tables!=="object"||Array.isArray(body.tables))return c.json({error:"INVALID_IMPORT_FILE"},400);
 const allowed=new Set<string>(ADMIN_EXPORT_TABLES),statements:any[]=[];let imported=0;
 for(const [table,rows] of Object.entries(body.tables)){
  if(!allowed.has(table)||!Array.isArray(rows))return c.json({error:"INVALID_IMPORT_TABLE",table},400);
  if(rows.length>5000||imported+rows.length>10000)return c.json({error:"IMPORT_ROW_LIMIT"},413);
  for(const row of rows as any[]){
   if(!row||typeof row!=="object"||Array.isArray(row))return c.json({error:"INVALID_IMPORT_ROW",table},400);
   const keys=Object.keys(row);
   if(!keys.length||keys.some(key=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))return c.json({error:"INVALID_IMPORT_COLUMNS",table},400);
   if(["administrators","wallet_transactions","subscriptions","projects","vps_servers","agent_tasks","backups","project_uploads","project_upload_chunks"].includes(table))return c.json({error:"IMPORT_TABLE_NOT_ALLOWED",table},400);
   const columns=keys.map(key=>"\""+key+"\"").join(",");
   const placeholders=keys.map(()=>"?").join(",");
   const updates=keys.filter(key=>key!=="id"&&key!=="telegram_id"&&key!=="key").map(key=>"\""+key+"\"=excluded.\""+key+"\"").join(",");
   const conflict=table==="users"?"telegram_id":table==="settings"?"key":table==="plans"?"id":table==="payment_methods"?"id":table==="announcements"?"id":table==="campaigns"?"id":"id";
   const sql="INSERT INTO "+table+"("+columns+") VALUES("+placeholders+") ON CONFLICT("+conflict+") "+(updates?"DO UPDATE SET "+updates:"DO NOTHING");
   statements.push(c.env.DB.prepare(sql).bind(...keys.map(key=>row[key]===undefined?null:row[key])));
   imported++;
  }
 }
 for(let i=0;i<statements.length;i+=50)await c.env.DB.batch(statements.slice(i,i+50));
 await c.env.DB.prepare("INSERT INTO audit_logs(staff_telegram_id,action,target_type,target_id,metadata_json,result) VALUES(?,?,?,?,?,?)")
  .bind(admin.id,"data.import","backup","json",JSON.stringify({rows:imported,tables:Object.keys(body.tables)}),"success").run();
 return c.json({ok:true,imported_rows:imported,tables:Object.keys(body.tables)});
});
app.get("/api/announcements",async c=>{
 const rows=await c.env.DB.prepare("SELECT id,title,description,image_url,button_text,button_url,button_enabled,created_at FROM announcements WHERE enabled=1 AND (starts_at IS NULL OR datetime(starts_at)<=CURRENT_TIMESTAMP) AND (ends_at IS NULL OR datetime(ends_at)>CURRENT_TIMESTAMP) ORDER BY created_at DESC LIMIT 20").all();
 return c.json({announcements:rows.results||[]});
});
app.get("/api/admin/announcements",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const rows=await c.env.DB.prepare("SELECT * FROM announcements ORDER BY created_at DESC LIMIT 200").all();return c.json({announcements:rows.results||[]});
});
app.post("/api/admin/announcements",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const b=await c.req.json<any>().catch(()=>null);
 if(!b||typeof b.title!=="string"||!b.title.trim()||b.title.length>160||typeof b.description!=="string"||b.description.length>4000)return c.json({error:"INVALID_ANNOUNCEMENT"},400);
 const buttonEnabled=!!b.button_enabled,buttonText=String(b.button_text||"").trim().slice(0,40),buttonUrl=String(b.button_url||"").trim();
 if(buttonEnabled&&(!buttonText||!/^https:\/\//i.test(buttonUrl)))return c.json({error:"BUTTON_REQUIRES_HTTPS_URL"},400);
 const imageUrl=String(b.image_url||"").slice(0,1000)||null;
 const result=await c.env.DB.prepare("INSERT INTO announcements(title,body,description,image_path,image_url,button_text,button_url,button_enabled,enabled,starts_at,ends_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
 .bind(b.title.trim(),b.description,b.description,imageUrl,imageUrl,buttonText||null,buttonUrl||null,buttonEnabled?1:0,b.enabled===false?0:1,b.starts_at||null,b.ends_at||null,admin.id).run();
 return c.json({ok:true,id:result.meta.last_row_id},201);
});
app.put("/api/admin/announcements/:id",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const b=await c.req.json<any>().catch(()=>null);if(!b)return c.json({error:"INVALID_ANNOUNCEMENT"},400);
 const current=await c.env.DB.prepare("SELECT * FROM announcements WHERE id=?").bind(c.req.param("id")).first<any>();if(!current)return c.json({error:"NOT_FOUND"},404);
 const buttonEnabled=!!b.button_enabled,buttonText=String(b.button_text||"").trim().slice(0,40),buttonUrl=String(b.button_url||"").trim();
 if(buttonEnabled&&(!buttonText||!/^https:\/\//i.test(buttonUrl)))return c.json({error:"BUTTON_REQUIRES_HTTPS_URL"},400);
 const nextTitle=String(b.title===undefined?current.title:b.title).trim().slice(0,160),nextDescription=String(b.description===undefined?current.description:b.description).slice(0,4000),nextImage=String((b.image_url===undefined?current.image_url:b.image_url)||"").slice(0,1000)||null;
 await c.env.DB.prepare("UPDATE announcements SET title=?,body=?,description=?,image_path=?,image_url=?,button_text=?,button_url=?,button_enabled=?,enabled=?,starts_at=?,ends_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
 .bind(nextTitle,nextDescription,nextDescription,nextImage,nextImage,String((b.button_text===undefined?current.button_text:b.button_text)||"").slice(0,40)||null,String((b.button_url===undefined?current.button_url:b.button_url)||"").slice(0,1000)||null,(b.button_enabled===undefined?current.button_enabled:(buttonEnabled?1:0)),(b.enabled===undefined?current.enabled:(b.enabled===false?0:1)),(b.starts_at===undefined?current.starts_at:b.starts_at),(b.ends_at===undefined?current.ends_at:b.ends_at),Number(c.req.param("id"))).run();
 return c.json({ok:true});
});
app.delete("/api/admin/announcements/:id",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 await c.env.DB.prepare("DELETE FROM announcements WHERE id=?").bind(c.req.param("id")).run();return c.json({ok:true});
});
app.get("/api/admin/campaigns",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const rows=await c.env.DB.prepare("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 200").all();return c.json({campaigns:rows.results||[]});
});
app.post("/api/admin/campaigns",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const b=await c.req.json<any>().catch(()=>null);
 if(!b||typeof b.title!=="string"||!b.title.trim()||b.title.length>160||!["all","active","premium","free"].includes(b.audience||"all"))return c.json({error:"INVALID_CAMPAIGN"},400);
 const scheduledAt=String(b.scheduled_at||"").trim()||null;if(scheduledAt&&Number.isNaN(Date.parse(scheduledAt)))return c.json({error:"INVALID_SCHEDULE_TIME"},400);
 const status=scheduledAt?"scheduled":"draft",payload={image_url:b.image_url||null,button_text:b.button_text||null,button_url:b.button_url||null};
 const result=await c.env.DB.prepare("INSERT INTO campaigns(title,description,kind,reward_minor,currency,config_json,enabled,starts_at,audience,payload_json,status,scheduled_at,created_by,updated_at) VALUES(?,?,'broadcast',0,'USD',?,1,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
 .bind(b.title.trim(),String(b.description||"").slice(0,4000),JSON.stringify(payload),scheduledAt,b.audience||"all",JSON.stringify(payload),status,scheduledAt,admin.id).run();
 return c.json({ok:true,id:result.meta.last_row_id,status},201);
});
app.put("/api/admin/campaigns/:id",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const b=await c.req.json<any>().catch(()=>null);if(!b)return c.json({error:"INVALID_CAMPAIGN"},400);
 if(!["draft","scheduled","cancelled"].includes(b.status||"draft"))return c.json({error:"INVALID_CAMPAIGN_STATUS"},400);
 const result=await c.env.DB.prepare("UPDATE campaigns SET title=?,description=?,audience=?,payload_json=?,status=?,scheduled_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND sent_at IS NULL")
 .bind(String(b.title||"").trim().slice(0,160),String(b.description||"").slice(0,4000),["all","active","premium","free"].includes(b.audience)?b.audience:"all",JSON.stringify(b.payload||{}),b.status||"draft",b.scheduled_at||null,c.req.param("id")).run();
 return c.json(result.meta.changes?{ok:true}:{error:"CAMPAIGN_NOT_FOUND_OR_SENT"},result.meta.changes?200:404);
});
app.delete("/api/admin/campaigns/:id",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 await c.env.DB.prepare("DELETE FROM campaigns WHERE id=? AND sent_at IS NULL").bind(c.req.param("id")).run();return c.json({ok:true});
});
app.get("/api/admin/coupons",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const rows=await c.env.DB.prepare("SELECT * FROM coupons ORDER BY created_at DESC LIMIT 300").all();return c.json({coupons:rows.results||[]});
});
app.post("/api/admin/coupons",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const b=await c.req.json<any>().catch(()=>null);const code=String(b?.code||"").trim().toUpperCase();
 if(!b||!/^[A-Z0-9_-]{3,32}$/.test(code)||!["percent","fixed"].includes(b.discount_type)||!Number.isSafeInteger(b.discount_value)||b.discount_value<1||(b.discount_type==="percent"&&b.discount_value>100))return c.json({error:"INVALID_COUPON"},400);
 let result:any;try{result=await c.env.DB.prepare("INSERT INTO coupons(code,kind,value_minor,currency,max_redemptions,per_user_limit,redeemed_count,enabled,expires_at,discount_type,discount_value,redemption_count,starts_at,created_by) VALUES(?,?,?,?,?,1,0,?,?,?,?,?,?,?)")
 .bind(code,b.discount_type,b.discount_value,b.currency==="INR"?"INR":"USD",Number.isSafeInteger(b.max_redemptions)&&b.max_redemptions>0?b.max_redemptions:null,b.enabled===false?0:1,b.expires_at||null,b.discount_type,b.discount_value,0,b.starts_at||null,admin.id).run();}
 catch{return c.json({error:"COUPON_CODE_ALREADY_EXISTS"},409);}return c.json({ok:true,id:result.meta.last_row_id},201);
});
app.put("/api/admin/coupons/:id",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const b=await c.req.json<any>().catch(()=>null);if(!b)return c.json({error:"INVALID_COUPON"},400);
 const enabled=b.enabled===false?0:1;const result=await c.env.DB.prepare("UPDATE coupons SET enabled=? WHERE id=?").bind(enabled,c.req.param("id")).run();
 return c.json(result.meta.changes?{ok:true}:{error:"COUPON_NOT_FOUND"},result.meta.changes?200:404);
});
app.delete("/api/admin/coupons/:id",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const r=await c.env.DB.prepare("DELETE FROM coupons WHERE id=?").bind(c.req.param("id")).run();return c.json({ok:true,deleted:!!r.meta.changes});
});
app.get("/api/admin/payment-methods",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const rows=await c.env.DB.prepare("SELECT * FROM payment_methods ORDER BY sort_order,id").all();return c.json({methods:rows.results||[]});
});
app.post("/api/admin/payment-methods",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const b=await c.req.json<any>().catch(()=>null);
 if(!b||typeof b.name!=="string"||!b.name.trim()||b.name.length>80||typeof b.kind!=="string"||!b.kind.trim()||typeof b.currency!=="string"||!Number.isSafeInteger(b.min_amount_minor)||b.min_amount_minor<0)return c.json({error:"INVALID_PAYMENT_METHOD"},400);
 try{const r=await c.env.DB.prepare("INSERT INTO payment_methods(name,kind,instructions,min_amount_minor,max_amount_minor,currency,enabled,sort_order) VALUES(?,?,?,?,?,?,?,?)")
 .bind(b.name.trim(),b.kind.trim().slice(0,40),String(b.instructions||"").slice(0,2000),b.min_amount_minor,Number.isSafeInteger(b.max_amount_minor)&&b.max_amount_minor>0?b.max_amount_minor:null,b.currency==="INR"?"INR":"USD",b.enabled===false?0:1,Number.isSafeInteger(b.sort_order)?b.sort_order:0).run();
 return c.json({ok:true,id:r.meta.last_row_id},201);}catch{return c.json({error:"PAYMENT_METHOD_CREATE_FAILED"},400);}
});
app.put("/api/admin/payment-methods/:id",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const b=await c.req.json<any>().catch(()=>null);if(!b)return c.json({error:"INVALID_PAYMENT_METHOD"},400);
 const r=await c.env.DB.prepare("UPDATE payment_methods SET name=?,kind=?,instructions=?,min_amount_minor=?,max_amount_minor=?,currency=?,enabled=?,sort_order=? WHERE id=?")
 .bind(String(b.name||"").trim().slice(0,80),String(b.kind||"").trim().slice(0,40),String(b.instructions||"").slice(0,2000),Math.max(0,Number(b.min_amount_minor||0)),Number.isSafeInteger(b.max_amount_minor)&&b.max_amount_minor>0?b.max_amount_minor:null,b.currency==="INR"?"INR":"USD",b.enabled===false?0:1,Number(b.sort_order||0),Number(c.req.param("id"))).run();
 return c.json(r.meta.changes?{ok:true}:{error:"PAYMENT_METHOD_NOT_FOUND"},r.meta.changes?200:404);
});
app.delete("/api/admin/payment-methods/:id",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const r=await c.env.DB.prepare("UPDATE payment_methods SET enabled=0 WHERE id=?").bind(Number(c.req.param("id"))).run();return c.json({ok:true,disabled:!!r.meta.changes});
});
app.get("/api/admin/payments",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const status=c.req.query("status");const rows=status?await c.env.DB.prepare("SELECT pr.*,u.telegram_id,u.username,u.first_name,pm.name AS method_name FROM payment_requests pr JOIN users u ON u.id=pr.user_id LEFT JOIN payment_methods pm ON pm.id=pr.method_id WHERE pr.status=? ORDER BY pr.created_at DESC LIMIT 300").bind(status).all():await c.env.DB.prepare("SELECT pr.*,u.telegram_id,u.username,u.first_name,pm.name AS method_name FROM payment_requests pr JOIN users u ON u.id=pr.user_id LEFT JOIN payment_methods pm ON pm.id=pr.method_id ORDER BY pr.created_at DESC LIMIT 300").all();
 return c.json({payments:rows.results||[]});
});
app.get("/api/admin/plans",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const rows=await c.env.DB.prepare("SELECT * FROM plans ORDER BY sort_order,id").all();return c.json({plans:rows.results||[]});
});
app.post("/api/admin/plans",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const b=await c.req.json<any>().catch(()=>null);
 if(!b||typeof b.name!=="string"||!b.name.trim()||typeof b.slug!=="string"||!/^[a-z0-9-]{2,40}$/.test(b.slug)||!Number.isSafeInteger(b.price_minor)||b.price_minor<0||!Number.isSafeInteger(b.duration_days)||b.duration_days<1)return c.json({error:"INVALID_PLAN"},400);
 const numeric=["max_projects","max_upload_bytes","max_file_bytes","max_files","cpu_millicores","ram_mb","storage_mb"];
 if(numeric.some(k=>!Number.isSafeInteger(b[k])||b[k]<1))return c.json({error:"INVALID_PLAN_LIMITS"},400);
 try{const r=await c.env.DB.prepare("INSERT INTO plans(name,slug,description,badge,price_minor,currency,duration_days,max_projects,max_upload_bytes,max_file_bytes,max_files,cpu_millicores,ram_mb,storage_mb,enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
 .bind(b.name.trim().slice(0,80),b.slug,String(b.description||"").slice(0,1000),String(b.badge||"").slice(0,40),b.price_minor,b.currency==="INR"?"INR":"USD",b.duration_days,b.max_projects,b.max_upload_bytes,b.max_file_bytes,b.max_files,b.cpu_millicores,b.ram_mb,b.storage_mb,b.enabled===false?0:1).run();
 return c.json({ok:true,id:r.meta.last_row_id},201);}catch{return c.json({error:"PLAN_SLUG_ALREADY_EXISTS_OR_INVALID"},409);}
});
app.put("/api/admin/plans/:id",async c=>{
 const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
 const b=await c.req.json<any>().catch(()=>null);if(!b)return c.json({error:"INVALID_PLAN"},400);
 const fields=["price_minor","duration_days","max_projects","max_upload_bytes","max_file_bytes","max_files","cpu_millicores","ram_mb","storage_mb"];
 if(fields.some(k=>!Number.isSafeInteger(b[k])||b[k]<0)||b.duration_days<1||b.max_projects<1||b.max_files<1)return c.json({error:"INVALID_PLAN_LIMITS"},400);
 const r=await c.env.DB.prepare("UPDATE plans SET name=?,description=?,badge=?,price_minor=?,currency=?,duration_days=?,max_projects=?,max_upload_bytes=?,max_file_bytes=?,max_files=?,cpu_millicores=?,ram_mb=?,storage_mb=?,enabled=? WHERE id=?")
 .bind(String(b.name||"").trim().slice(0,80),String(b.description||"").slice(0,1000),String(b.badge||"").slice(0,40),b.price_minor,b.currency==="INR"?"INR":"USD",b.duration_days,b.max_projects,b.max_upload_bytes,b.max_file_bytes,b.max_files,b.cpu_millicores,b.ram_mb,b.storage_mb,b.enabled===false?0:1,Number(c.req.param("id"))).run();
 return c.json(r.meta.changes?{ok:true}:{error:"PLAN_NOT_FOUND"},r.meta.changes?200:404);
});

app.all("/api/*",c=>c.json({error:"NOT_IMPLEMENTED",message:"This endpoint is not implemented yet."},501));
app.get("*",c=>c.env.ASSETS.fetch(c.req.raw));
async function runBackupRetention(db:D1Database){
 const expired=await db.prepare(`SELECT b.id,b.project_id,b.server_id FROM backups b
  JOIN projects p ON p.id=b.project_id
  WHERE b.status='completed' AND b.expires_at IS NOT NULL AND datetime(b.expires_at)<=CURRENT_TIMESTAMP
  AND p.deleted_at IS NULL ORDER BY b.expires_at LIMIT 50`).all<{id:string;project_id:string;server_id:number}>();
 let queued=0;
 for(const backup of expired.results||[]){
  const taskId=crypto.randomUUID();
  const results=await db.batch([
   db.prepare("UPDATE backups SET status='deleting' WHERE id=? AND status='completed'").bind(backup.id),
   db.prepare("INSERT INTO agent_tasks(id,server_id,project_id,action,payload_json) SELECT ?,?,?, 'restart', ? WHERE EXISTS(SELECT 1 FROM backups WHERE id=? AND status='deleting')").bind(taskId,backup.server_id,backup.project_id,JSON.stringify({control_action:"backup",backup_action:"delete",backup_id:backup.id}),backup.id)
  ]);
  if(results[0]?.meta?.changes)queued++;
 }
 return queued;
}
async function runCampaignDelivery(env:Env){
 const due=await env.DB.prepare("SELECT * FROM campaigns WHERE status='scheduled' AND scheduled_at IS NOT NULL AND datetime(scheduled_at)<=CURRENT_TIMESTAMP ORDER BY scheduled_at LIMIT 3").all<any>();
 for(const campaign of due.results||[]){
  const lock=await env.DB.prepare("UPDATE campaigns SET status='sending' WHERE id=? AND status='scheduled'").bind(campaign.id).run();
  if(!lock.meta.changes)continue;
  let payload:any={};try{payload=JSON.parse(campaign.payload_json||"{}");}catch{}
  let recipients:any;
  if(campaign.audience==="premium")recipients=await env.DB.prepare("SELECT DISTINCT u.telegram_id FROM users u JOIN subscriptions s ON s.user_id=u.id JOIN plans p ON p.id=s.plan_id WHERE s.status='active' AND datetime(s.expires_at)>CURRENT_TIMESTAMP AND p.slug<>'free' LIMIT 1000").all();
  else if(campaign.audience==="free")recipients=await env.DB.prepare("SELECT u.telegram_id FROM users u WHERE NOT EXISTS(SELECT 1 FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=u.id AND s.status='active' AND datetime(s.expires_at)>CURRENT_TIMESTAMP AND p.slug<>'free') LIMIT 1000").all();
  else recipients=await env.DB.prepare("SELECT telegram_id FROM users WHERE status='active' LIMIT 1000").all();
  let sent=0,failed=0;
  for(const user of recipients.results||[]){
   const message=[campaign.title,campaign.description].filter(Boolean).join("\n\n");
   const keyboard=payload.button_text&&payload.button_url?{inline_keyboard:[[{text:String(payload.button_text).slice(0,40),url:String(payload.button_url)}]]}:undefined;
   const method=payload.image_url?"sendPhoto":"sendMessage";
   const params:any=payload.image_url?{chat_id:user.telegram_id,photo:payload.image_url,caption:message,reply_markup:keyboard}:{chat_id:user.telegram_id,text:message,reply_markup:keyboard,disable_web_page_preview:true};
   try{const response=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/"+method,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(params)});const result:any=await response.json();if(result.ok)sent++;else failed++;}catch{failed++;}
  }
  await env.DB.prepare("UPDATE campaigns SET status='sent',sent_at=CURRENT_TIMESTAMP,payload_json=? WHERE id=? AND status='sending'").bind(JSON.stringify({...payload,delivery:{sent,failed}}),campaign.id).run();
 }
}
export default {
 fetch: app.fetch,
 async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext){
  ctx.waitUntil(Promise.all([runBackupRetention(env.DB).catch(error=>console.error("HostPilot backup retention failed",error)),runCampaignDelivery(env).catch(error=>console.error("HostPilot campaign delivery failed",error))]));
 }
};
