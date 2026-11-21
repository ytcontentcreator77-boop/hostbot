import { validateInitData, type TelegramUser } from "./auth";
export interface Env { DB: D1Database; ASSETS: Fetcher; BOT_TOKEN: string; BOT_WEBHOOK_SECRET: string; OWNER_IDS?: string; APP_URL?: string }
export async function requireTelegramUser(request: Request, env: Env): Promise<TelegramUser | null> {
  return validateInitData(request.headers.get("X-Telegram-Init-Data") || "", env.BOT_TOKEN);
}
export async function requireAdmin(request: Request, env: Env): Promise<TelegramUser | null> {
  const user = await requireTelegramUser(request, env);
  if (!user) return null;
  const owners = (env.OWNER_IDS || "").split(",").map(x=>x.trim()).filter(Boolean);
  if (owners.includes(String(user.id))) return user;
  const row = await env.DB.prepare("SELECT telegram_id FROM administrators WHERE telegram_id = ?").bind(user.id).first();
  if (row) return user;
  return null;
}
export function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff=0; for(let i=0;i<a.length;i++) diff |= a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
