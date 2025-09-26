// quick-connect.js
// Usage: node quick-connect.js <type>
// <type> should be either 'mysql' or 'postgres'

const mysql = require('mysql2');
const { Client } = require('pg');

const type = process.argv[2];

if (!type || (type !== 'mysql' && type !== 'postgres')) {
  console.error("Usage: node quick-connect.js <type>\n<type> should be 'mysql' or 'postgres'");
  process.exit(1);
}

if (type === 'mysql') {
  const connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'password',
    database: 'testdb'
  });

  connection.connect(err => {
    if (err) {
      console.error('MySQL connection error:', err);
      process.exit(1);
    }
    console.log('Connected to MySQL!');
    connection.end();
  });
} else if (type === 'postgres') {
  const client = new Client({
    host: 'localhost',
    user: 'postgres',
    password: 'password',
    database: 'testdb'
  });

  client.connect(err => {
    if (err) {
      console.error('Postgres connection error:', err);
      process.exit(1);
    }
    console.log('Connected to Postgres!');
    client.end();
  });
}
