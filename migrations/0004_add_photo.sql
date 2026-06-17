-- Add headshot photo_url column to players table.
-- Stores the Cloudflare R2 public URL of the cropped headshot image.
ALTER TABLE players ADD COLUMN photo_url TEXT NOT NULL DEFAULT '';
