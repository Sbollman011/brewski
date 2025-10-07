#!/usr/bin/env node

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');

function seedCustomers() {
  const db = new Database(DB_PATH);
  
  try {
    const now = Date.now();
    
    // Check if customers already exist
    const existing = db.prepare('SELECT slug FROM customers WHERE slug IN (?, ?)').all('RAIL', 'BREW');
    const existingSlugs = existing.map(c => c.slug);
    
    if (!existingSlugs.includes('RAIL')) {
      console.log('Creating RAIL customer...');
      db.prepare('INSERT INTO customers (slug, name, created_at) VALUES (?, ?, ?)').run('RAIL', 'RAIL Operations', now);
    } else {
      console.log('RAIL customer already exists');
    }
    
    if (!existingSlugs.includes('BREW')) {
      console.log('Creating BREW customer...');
      db.prepare('INSERT INTO customers (slug, name, created_at) VALUES (?, ?, ?)').run('BREW', 'Brewing Operations', now);
    } else {
      console.log('BREW customer already exists');
    }
    
    // Show all customers
    const customers = db.prepare('SELECT id, slug, name FROM customers ORDER BY slug').all();
    console.log('\nAll customers:');
    customers.forEach(c => {
      console.log(`  ${c.id}: ${c.slug} (${c.name})`);
    });
    
    console.log('\nCustomer seeding completed!');
    
  } catch (error) {
    console.error('Error seeding customers:', error);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  seedCustomers();
}

module.exports = { seedCustomers };