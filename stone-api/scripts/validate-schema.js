const dotenv = require("dotenv");
const { getPool, hasMySqlConfig, getMissingMySqlEnv } = require("../db");

dotenv.config();

async function main() {
  if (!hasMySqlConfig()) {
    const missing = getMissingMySqlEnv();
    console.log(
      `[schema-check] Skipped. Missing DB env vars: ${missing.join(", ")}`
    );
    process.exit(0);
  }

  const pool = getPool();
  const dbName = process.env.DB_NAME;
  const expected = {
    stone: ["code", "name", "material", "type", "color", "finish", "applications"],
    material_content_pages: ["page_content", "published"],
  };

  let hasErrors = false;

  for (const [table, columns] of Object.entries(expected)) {
    const [tableRows] = await pool.execute(
      `
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = ?
      LIMIT 1
      `,
      [dbName, table]
    );

    if (!tableRows.length) {
      hasErrors = true;
      console.error(`[schema-check] Missing table: ${table}`);
      continue;
    }

    const [columnRows] = await pool.execute(
      `
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = ?
      `,
      [dbName, table]
    );

    const existing = new Set(columnRows.map((row) => row.COLUMN_NAME));
    const missingColumns = columns.filter((name) => !existing.has(name));

    if (missingColumns.length) {
      hasErrors = true;
      console.error(
        `[schema-check] Missing columns in ${table}: ${missingColumns.join(", ")}`
      );
    } else {
      console.log(`[schema-check] OK: ${table}`);
    }
  }

  await pool.end();

  if (hasErrors) {
    process.exit(1);
  }

  console.log("[schema-check] Schema validation passed.");
}

main().catch((error) => {
  console.error("[schema-check] Failed:", error.message);
  process.exit(1);
});
