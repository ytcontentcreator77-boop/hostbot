import { Hono } from "hono";
import { validateInitData } from "./auth";
import { appendWalletTransaction } from "./ledger";
import { constantTimeEqual, requireAdmin, type Env } from "./guards";

const app = new Hono<{ Bindings: Env }>();
app.get("/health", c => c.json({ ok: true, service: "hostpilot-control-plane" }));
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
  return c.json({user:profile});
});
app.get("/api/plans",async c=>{
  const result=await c.env.DB.prepare("SELECT id,name,slug,description,badge,price_minor,currency,duration_days,max_projects,max_upload_bytes,max_files,cpu_millicores,ram_mb,storage_mb,allowed_runtimes,enabled FROM plans WHERE enabled=1 ORDER BY sort_order,id").all();
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
app.get("/api/admin/servers",async c=>{
  const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
  const rows=await c.env.DB.prepare("SELECT id,name,provider,region,endpoint,status,capacity_json,agent_version,last_heartbeat_at,enabled,last_error,created_at FROM vps_servers ORDER BY id DESC").all();
  return c.json({servers:rows.results||[]});
});
app.post("/api/admin/servers",async c=>{
  const admin=await requireAdmin(c.req.raw,c.env);if(!admin)return c.json({error:"FORBIDDEN"},403);
  const body=await c.req.json<{name:string;provider?:string;region?:string;endpoint?:string}>().catch(()=>null);
  if(!body||typeof body.name!=="string"||body.name.trim().length<2||body.name.length>80)return c.json({error:"INVALID_SERVER"},400);
  const provider=String(body.provider||"custom").trim().slice(0,60);
  const region=String(body.region||"").trim().slice(0,80)||null;
  const endpoint=String(body.endpoint||"").trim();
  if(endpoint&&!endpoint.startsWith("https://"))return c.json({error:"ENDPOINT_MUST_USE_HTTPS"},400);
  const token=crypto.randomUUID().replace(/-/g,"")+crypto.randomUUID().replace(/-/g,"");
  const hash=await sha256Hex(token);
  const result=await c.env.DB.prepare("INSERT INTO vps_servers(name,provider,region,endpoint,status,capacity_json,agent_token_hash,enabled) VALUES(?,?,?,?,'pending','{}',?,1)")
    .bind(body.name.trim(),provider,region,endpoint,hash).run();
  const serverId=Number(result.meta.last_row_id);
  await c.env.DB.prepare("INSERT INTO audit_logs(staff_telegram_id,action,target_type,target_id,metadata_json,result) VALUES(?,?,?,?,?,?)")
    .bind(admin.id,"server.register","vps_server",String(serverId),JSON.stringify({name:body.name,provider,region}),"success").run();
  return c.json({ok:true,server_id:serverId,agent_token:token,warning:"Copy this token now. It is shown only once."},201);
});

async function terminalEntitlement(db:D1Database,telegramId:number){
  const row=await db.prepare(`SELECT u.id,u.terminal_override,s.status AS subscription_status,p.slug AS plan_slug,
    COALESCE(p.terminal_enabled,0) AS plan_terminal_enabled
    FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id AND s.status='active'
    LEFT JOIN plans p ON p.id=s.plan_id
    WHERE u.telegram_id=? ORDER BY s.id DESC LIMIT 1`).bind(telegramId)
    .first<{id:number;terminal_override:number|null;subscription_status:string|null;plan_slug:string|null;plan_terminal_enabled:number}>();
  if(!row)return {allowed:false,source:"none",reason:"USER_NOT_FOUND"};
  const allowed=row.terminal_override===1?true:row.terminal_override===0?false:row.plan_terminal_enabled===1;
  return {allowed,source:row.terminal_override===null?"plan":"admin_override",
    plan:row.plan_slug||"free",reason:allowed?"ENABLED":"TERMINAL_NOT_INCLUDED"};
}
app.get("/api/terminal/access",async c=>{
  const user=await validateInitData(c.req.header("X-Telegram-Init-Data")||"",c.env.BOT_TOKEN);
  if(!user)return c.json({error:"UNAUTHORIZED"},401);
  return c.json(await terminalEntitlement(c.env.DB,user.id));
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
app.all("/api/*",c=>c.json({error:"NOT_IMPLEMENTED",message:"This endpoint is not implemented yet."},501));
app.get("*",c=>c.env.ASSETS.fetch(c.req.raw));
export default app;
