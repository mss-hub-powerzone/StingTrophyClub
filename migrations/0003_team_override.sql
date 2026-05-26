-- Adds an explicit per-player team override.
--
-- Empty string ('') means "auto": the worker derives team_bucket / team_label
-- / coach / league from birthdate as before. 'U17' or 'U16' pins the player to
-- that team regardless of birthdate, which is useful for players playing up or
-- born outside the standard age window but still rostered with the club.
--
-- The override is the single source of truth for offer-email template routing
-- on the dashboard; the worker writes the canonical (bucket, label, coach,
-- league) tuple when the override is non-empty.

ALTER TABLE players ADD COLUMN team_override TEXT NOT NULL DEFAULT '';
