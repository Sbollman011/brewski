-- Migration: Add power_labels table for mapping labels to POWER keys per topic/customer
-- Place this in server/migrations/ or run manually if you don't use a migration system

CREATE TABLE IF NOT EXISTS power_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  topic TEXT NOT NULL,
  power_key TEXT NOT NULL,
  label TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER DEFAULT (strftime('%s','now')*1000),
  UNIQUE(customer_id, topic, power_key)
);
