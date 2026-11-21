import { Hono } from "hono";
import { validateInitData } from "./auth";
import { constantTimeEqual, requireAdmin, type Env } from "./guards";

const app = new Hono<{ Bindings: Env }>();
app.get("/health", c => c.json({ ok: true, service: "hostpilot-control-plane" }));

app.get("/api/public", async c => {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'setup_done'").first<{value:string}>();
  return c.json({ configured: row?.value === "1", service: "HostPilot" });
});

app.get("/api/me", async c => {
  const user = await validateInitData(c.req.header("X-Telegram-Init-Data") || "", c.env.BOT_TOKEN);
  if (!user) return c.json({ error: "UNAUTHORIZED" }, 401);
  await c.env.DB.prepare(`INSERT INTO users (telegram_id,first_name,last_name,username,language_code,last_seen_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,
    username=excluded.username,updated_at=CURRENT_TIMESTAMP,last_seen_at=CURRENT_TIMESTAMP`)
    .bind(user.id,user.first_name || "",user.last_name || null,user.username || null,user.language_code || "en").run();
  const profile = await c.env.DB.prepare("SELECT id,telegram_id,first_name,last_name,username,language_code,status,created_at FROM users WHERE telegram_id=?").bind(user.id).first();
  return c.json({ user: profile });
});

app.get("/api/plans", async c => {
  const result = await c.env.DB.prepare("SELECT id,name,slug,description,badge,price_minor,currency,duration_days,max_projects,max_upload_bytes,max_files,cpu_millicores,ram_mb,storage_mb,allowed_runtimes,enabled FROM plans WHERE enabled=1 ORDER BY sort_order,id").all();
  return c.json({ plans: result.results || [] });
});

app.get("/api/dashboard", async c => {
  const user = await validateInitData(c.req.header("X-Telegram-Init-Data") || "", c.env.BOT_TOKEN);
  if (!user) return c.json({ error: "UNAUTHORIZED" }, 401);
  const row = await c.env.DB.prepare("SELECT id FROM users WHERE telegram_id=?").bind(user.id).first<{id:number}>();
  if (!row) return c.json({ error: "USER_NOT_REGISTERED" }, 404);
  const [projects, sub, wallet] = await Promise.all([
    c.env.DB.prepare("SELECT status,COUNT(*) AS count FROM projects WHERE user_id=? AND deleted_at IS NULL GROUP BY status").bind(row.id).all(),
    c.env.DB.prepare("SELECT s.status,s.expires_at,p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=? ORDER BY s.id DESC LIMIT 1").bind(row.id).first(),
    c.env.DB.prepare("SELECT balance_minor,currency FROM wallets WHERE user_id=?").bind(row.id).first()
  ]);
  return c.json({ projects: projects.results || [], subscription: sub || null, wallet: wallet || {balance_minor:0,currency:"USD"} });
});

app.get("/api/admin/overview", async c => {
  const admin = await requireAdmin(c.req.raw,c.env);
  if (!admin) return c.json({error:"FORBIDDEN"},403);
  const [users,projects,payments,servers] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active FROM users").first(),
    c.env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed FROM projects WHERE deleted_at IS NULL").first(),
    c.env.DB.prepare("SELECT COUNT(*) pending FROM payment_requests WHERE status='pending'").first(),
    c.env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='healthy' THEN 1 ELSE 0 END) healthy FROM vps_servers").first()
  ]);
  return c.json({users,projects,payments,servers});
});

app.post("/bot", async c => {
  const supplied = c.req.header("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!constantTimeEqual(supplied,c.env.BOT_WEBHOOK_SECRET)) return c.json({ok:false},401);
  const update = await c.req.json<any>().catch(()=>null);
  const message = update?.message;
  if (!message?.chat?.id) return c.json({ok:true});
  const from = message.from || {};
  if (from.id) {
    await c.env.DB.prepare(`INSERT INTO users (telegram_id,first_name,last_name,username,language_code)
      VALUES (?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET first_name=excluded.first_name,
      last_name=excluded.last_name,username=excluded.username,updated_at=CURRENT_TIMESTAMP`)
      .bind(from.id,from.first_name || "",from.last_name || null,from.username || null,from.language_code || "en").run();
  }
  const command = String(message.text || "").trim().split(/\\s+/)[0].split("@")[0];
  const adminIds=(c.env.OWNER_IDS || "").split(",").map(x=>x.trim());
  const isAdmin=adminIds.includes(String(from.id)) || !!(await c.env.DB.prepare("SELECT telegram_id FROM administrators WHERE telegram_id=?").bind(from.id).first());
  let response = "Welcome to HostPilot. Manage Python and Node.js projects from the Mini App.";
  if (command === "/help") response = "HostPilot commands: /start, /language, /plans, /project, /support, /help.";
  else if (command === "/plans") response = "View available hosting plans in the HostPilot Mini App.";
  else if (command === "/language") response = "Change your language in the Mini App Profile.";
  else if (command === "/project") response = "Your project list is available in the HostPilot Mini App.";
  else if (command === "/support") response = "Open the HostPilot Mini App to contact support.";
  else if (["/admin","/stats","/broadcast","/users","/payments","/projects"].includes(command)) {
    if (!isAdmin) response = "You are not authorized to use this command.";
    else response = "Open the HostPilot Admin Panel to continue.";
  }
  const appUrl=c.env.APP_URL || "https://REPLACE_WITH_HOSTPILOT_DOMAIN";
  const reply:any={chat_id:message.chat.id,text:response};
  if (appUrl.startsWith("https://") && !appUrl.includes("REPLACE_WITH")) reply.reply_markup={inline_keyboard:[[{text:isAdmin && command==="/admin"?"Open Admin Panel":"Open HostPilot",web_app:{url:appUrl}}]]};
  await fetch(`https://api.telegram.org/bot${c.env.BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(reply)});
  return c.json({ok:true});
});

app.all("/api/*", c => c.json({error:"NOT_IMPLEMENTED",message:"This endpoint is not implemented yet."},501));
app.get("*", c => c.env.ASSETS.fetch(c.req.raw));
export default app;
