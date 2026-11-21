-- A user may have only one active subscription at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_subscription_per_user
ON subscriptions(user_id) WHERE status='active';
