-- HostPilot supports fiat wallet and billing currencies only: USD and INR.
-- USDT and all other currencies are deliberately excluded.
INSERT OR IGNORE INTO wallets(user_id,balance_minor,currency)
SELECT id,0,'USD' FROM users;
INSERT OR IGNORE INTO wallets(user_id,balance_minor,currency)
SELECT id,0,'INR' FROM users;

CREATE TRIGGER IF NOT EXISTS users_create_fiat_wallets
AFTER INSERT ON users
BEGIN
  INSERT OR IGNORE INTO wallets(user_id,balance_minor,currency) VALUES(NEW.id,0,'USD');
  INSERT OR IGNORE INTO wallets(user_id,balance_minor,currency) VALUES(NEW.id,0,'INR');
END;

CREATE TRIGGER IF NOT EXISTS wallets_currency_insert
BEFORE INSERT ON wallets
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN
  SELECT RAISE(ABORT,'unsupported currency: HostPilot supports USD and INR only');
END;
CREATE TRIGGER IF NOT EXISTS wallets_currency_update
BEFORE UPDATE OF currency ON wallets
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN
  SELECT RAISE(ABORT,'unsupported currency: HostPilot supports USD and INR only');
END;

CREATE TRIGGER IF NOT EXISTS plans_currency_insert
BEFORE INSERT ON plans
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'plans support USD and INR only'); END;
CREATE TRIGGER IF NOT EXISTS plans_currency_update
BEFORE UPDATE OF currency ON plans
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'plans support USD and INR only'); END;

CREATE TRIGGER IF NOT EXISTS payment_methods_currency_insert
BEFORE INSERT ON payment_methods
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'payment methods support USD and INR only'); END;
CREATE TRIGGER IF NOT EXISTS payment_methods_currency_update
BEFORE UPDATE OF currency ON payment_methods
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'payment methods support USD and INR only'); END;

CREATE TRIGGER IF NOT EXISTS payment_requests_currency_insert
BEFORE INSERT ON payment_requests
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'payments support USD and INR only'); END;
CREATE TRIGGER IF NOT EXISTS payment_requests_currency_update
BEFORE UPDATE OF currency ON payment_requests
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'payments support USD and INR only'); END;

CREATE TRIGGER IF NOT EXISTS campaigns_currency_insert
BEFORE INSERT ON campaigns
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'campaigns support USD and INR only'); END;
CREATE TRIGGER IF NOT EXISTS campaigns_currency_update
BEFORE UPDATE OF currency ON campaigns
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'campaigns support USD and INR only'); END;

CREATE TRIGGER IF NOT EXISTS bonus_rules_currency_insert
BEFORE INSERT ON bonus_rules
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'bonus rules support USD and INR only'); END;
CREATE TRIGGER IF NOT EXISTS bonus_rules_currency_update
BEFORE UPDATE OF currency ON bonus_rules
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'bonus rules support USD and INR only'); END;

CREATE TRIGGER IF NOT EXISTS coupons_currency_insert
BEFORE INSERT ON coupons
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'coupons support USD and INR only'); END;
CREATE TRIGGER IF NOT EXISTS coupons_currency_update
BEFORE UPDATE OF currency ON coupons
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'coupons support USD and INR only'); END;

CREATE TRIGGER IF NOT EXISTS referral_rewards_currency_insert
BEFORE INSERT ON referral_rewards
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'referral rewards support USD and INR only'); END;
CREATE TRIGGER IF NOT EXISTS referral_rewards_currency_update
BEFORE UPDATE OF currency ON referral_rewards
WHEN NEW.currency NOT IN ('USD','INR')
BEGIN SELECT RAISE(ABORT,'referral rewards support USD and INR only'); END;
