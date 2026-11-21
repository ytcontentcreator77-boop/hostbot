export interface TelegramUser { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string }
export async function validateInitData(raw: string, botToken: string, maxAgeSeconds = 86400): Promise<TelegramUser | null> {
  if (!raw || !botToken) return null;
  const params = new URLSearchParams(raw);
  const supplied = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  if (!supplied || !Number.isFinite(authDate) || Math.abs(Date.now()/1000-authDate) > maxAgeSeconds) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
  const enc = new TextEncoder();
  const secretKey = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", secretKey, enc.encode(botToken));
  const key = await crypto.subtle.importKey("raw", secret, {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(check)));
  const actual = [...digest].map(x=>x.toString(16).padStart(2,"0")).join("");
  if (actual.length !== supplied.length) return null;
  let diff = 0; for(let i=0;i<actual.length;i++) diff |= actual.charCodeAt(i)^supplied.charCodeAt(i);
  if(diff !== 0) return null;
  try { return JSON.parse(params.get("user") || "null") as TelegramUser | null; } catch { return null; }
}