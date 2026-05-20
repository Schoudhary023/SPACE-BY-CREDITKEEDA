-- Enable RLS on all vault tables.
-- Service role key (used by the bot) bypasses RLS automatically.
-- This blocks all anonymous / public Data API access.
ALTER TABLE users_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_cards_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE expiry_reminders_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_state_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_onboarding_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_actions_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_events_vault ENABLE ROW LEVEL SECURITY;
