import { Hono } from "hono";
import { validateInitData } from "./auth";

interface Env { DB: D1Database; ASSETS: Fetcher; BOT_TOKEN: string; OWNER_IDS?: string }
const app = new Hono<{ Bindings: Env }>();

app.get("/health", c => c.json({ ok: true, service: "hostpilot-control-plane" }));
app.get("/api/public", async c => {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'setup_done'").first<{value:string}>();
  return c.json({ configured: row?.value === "1", service: "HostPilot" });
});
app.get("/api/me", async c => {
  const raw = c.req.header("X-Telegram-Init-Data") || "";
  const user = await validateInitData(raw, c.env.BOT_TOKEN);
  if (!user) return c.json({ error: "UNAUTHORIZED" }, 401);
  await c.env.DB.prepare("INSERT INTO users (telegram_id, first_name, username, language_code) VALUES (?, ?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username, updated_at=CURRENT_TIMESTAMP")
    .bind(user.id, user.first_name || "", user.username || null, user.language_code || "en").run();
  return c.json({ user });
});
app.post("/bot", async c => {
  const update = await c.req.json<any>().catch(()=>null);
  const message = update?.message;
  const token = c.env.BOT_TOKEN;
  if (!message?.chat?.id || !token) return c.json({ok:true});
  const chatId = message.chat.id;
  const command = String(message.text || "").split(/\s+/)[0].split("@")[0];
  const text = command === "/help" ? "HostPilot: manage Python and Node.js projects in the Mini App." : "Welcome to HostPilot. Open the Mini App to manage your hosting.";
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({chat_id:chatId,text,reply_markup:{inline_keyboard:[[{text:"Open HostPilot",web_app:{url:"https://REPLACE_WITH_HOSTPILOT_DOMAIN"}}]]}}) });
  return c.json({ok:true});
});
app.all("/api/*", c => c.json({ error: "NOT_IMPLEMENTED", message: "This HostPilot API module is being built in stages." }, 501));
app.get("*", c => c.env.ASSETS.fetch(c.req.raw));
export default app;