-- Keep wallet balance changes inseparable from immutable ledger entries.
CREATE TRIGGER IF NOT EXISTS wallet_tx_validate_insert
BEFORE INSERT ON wallet_transactions
BEGIN
  SELECT CASE WHEN NEW.amount_minor <= 0 THEN RAISE(ABORT,'wallet transaction amount must be positive') END;
  SELECT CASE WHEN NEW.direction='debit'
    AND COALESCE((SELECT balance_minor FROM wallets WHERE user_id=NEW.user_id),0) < NEW.amount_minor
    THEN RAISE(ABORT,'insufficient wallet balance') END;
END;
CREATE TRIGGER IF NOT EXISTS wallet_tx_apply_balance
AFTER INSERT ON wallet_transactions
BEGIN
  UPDATE wallets SET balance_minor = balance_minor + CASE WHEN NEW.direction='credit' THEN NEW.amount_minor ELSE -NEW.amount_minor END
  WHERE user_id=NEW.user_id AND currency=NEW.currency;
END;
