const mysql = require("mysql2/promise");

let pool = null;

function getMissingMySqlEnv() {
  return ["DB_HOST", "DB_PORT", "DB_USER", "DB_NAME"].filter(
    (key) => !process.env[key]
  );
}

function hasMySqlConfig() {
  return getMissingMySqlEnv().length === 0;
}

function getPool() {
  if (!hasMySqlConfig()) return null;
  if (pool) return pool;

  pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  return pool;
}

module.exports = {
  getPool,
  hasMySqlConfig,
  getMissingMySqlEnv,
};
