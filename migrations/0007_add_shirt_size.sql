-- Migration 0007: add shirt_size column
ALTER TABLE players ADD COLUMN shirt_size TEXT NOT NULL DEFAULT '';
