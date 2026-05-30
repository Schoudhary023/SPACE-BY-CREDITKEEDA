#!/usr/bin/env node

/**
 * Migration script to add key_version to existing gift card records
 * Run this after deploying the key versioning update
 */

const { supabase } = require("../lib/supabase");

async function migrateKeyVersions() {
  console.log("Starting key version migration...");

  try {
    // Update all existing records to have key_version = 1
    const { data, error } = await supabase
      .from("gift_cards_vault")
      .update({ key_version: 1 })
      .is("key_version", null); // Only update records where key_version is null

    if (error) {
      console.error("Migration failed:", error);
      process.exit(1);
    }

    console.log(`Migration completed! Updated ${data ? data.length : 0} records.`);
  } catch (error) {
    console.error("Migration error:", error);
    process.exit(1);
  }
}

// Run migration if this script is executed directly
if (require.main === module) {
  migrateKeyVersions();
}

module.exports = { migrateKeyVersions };