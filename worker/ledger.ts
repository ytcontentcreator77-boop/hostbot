import type { Env } from "./guards";
export async function appendWalletTransaction(env:Env,input:{userId:number;amountMinor:number;currency:string;direction:"credit"|"debit";reason:string;referenceType?:string;referenceId?:string;idempotencyKey:string}) {
  if(!Number.isSafeInteger(input.amountMinor)||input.amountMinor<=0) throw new Error("INVALID_AMOUNT");
  if(input.currency!=="USD"&&input.currency!=="INR") throw new Error("UNSUPPORTED_CURRENCY");
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO wallets(user_id,balance_minor,currency) VALUES(?,0,?)").bind(input.userId,input.currency),
    env.DB.prepare(`INSERT INTO wallet_transactions(user_id,amount_minor,currency,direction,reason,reference_type,reference_id,idempotency_key)
      VALUES(?,?,?,?,?,?,?,?)`).bind(input.userId,input.amountMinor,input.currency,input.direction,input.reason,input.referenceType||null,input.referenceId||null,input.idempotencyKey)
  ]);
  return env.DB.prepare("SELECT balance_minor,currency FROM wallets WHERE user_id=? AND currency=?").bind(input.userId,input.currency).first<{balance_minor:number;currency:string}>();
}
