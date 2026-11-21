-- Upgrade the single-currency wallet to one balance per user and currency.
DROP TRIGGER IF EXISTS wallet_tx_validate_insert;
DROP TRIGGER IF EXISTS wallet_tx_apply_balance;
DROP TRIGGER IF EXISTS wallet_tx_approve_payment;
ALTER TABLE wallets RENAME TO wallets_legacy;
CREATE TABLE wallets (
  user_id INTEGER NOT NULL REFERENCES users(id),
  balance_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  PRIMARY KEY(user_id,currency)
);
INSERT INTO wallets(user_id,balance_minor,currency) SELECT user_id,balance_minor,currency FROM wallets_legacy;
DROP TABLE wallets_legacy;
CREATE TRIGGER wallet_tx_validate_insert
BEFORE INSERT ON wallet_transactions
BEGIN
  SELECT CASE WHEN NEW.amount_minor <= 0 THEN RAISE(ABORT,'wallet transaction amount must be positive') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallets WHERE user_id=NEW.user_id AND currency=NEW.currency)
    THEN RAISE(ABORT,'wallet currency mismatch or wallet missing') END;
  SELECT CASE WHEN NEW.direction='debit'
    AND COALESCE((SELECT balance_minor FROM wallets WHERE user_id=NEW.user_id AND currency=NEW.currency),0) < NEW.amount_minor
    THEN RAISE(ABORT,'insufficient wallet balance') END;
  SELECT CASE WHEN NEW.reference_type='payment' AND EXISTS(
    SELECT 1 FROM payment_requests WHERE id=NEW.reference_id AND status!='pending'
  ) THEN RAISE(ABORT,'payment is not pending') END;
END;
CREATE TRIGGER wallet_tx_apply_balance
AFTER INSERT ON wallet_transactions
BEGIN
  UPDATE wallets SET balance_minor=balance_minor+CASE WHEN NEW.direction='credit' THEN NEW.amount_minor ELSE -NEW.amount_minor END
  WHERE user_id=NEW.user_id AND currency=NEW.currency;
END;
CREATE TRIGGER wallet_tx_approve_payment
AFTER INSERT ON wallet_transactions
WHEN NEW.reference_type='payment'
BEGIN
  UPDATE payment_requests SET status='approved',reviewed_at=CURRENT_TIMESTAMP
  WHERE id=NEW.reference_id AND status='pending';
END;
