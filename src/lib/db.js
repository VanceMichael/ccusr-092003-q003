
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

// 打开数据库并确保迁移就绪（显式 `make migrate` 之外，服务启动与测试也能自助建表）。
function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);

  const migrationsDir = path.join(__dirname, "..", "..", "migrations");
  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version)
  );
  const insertApplied = database.prepare("INSERT INTO schema_migrations(version) VALUES (?)");

  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) {
      continue;
    }
    database.exec("BEGIN");
    try {
      database.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
      try {
        insertApplied.run(version);
      } catch (error) {
        if (!String(error.message).includes("UNIQUE")) {
          throw error;
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return database;
}

module.exports = { openDatabase };
