
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);

database.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const migrationsDir = path.join(process.cwd(), "migrations");
const applied = new Set(
  database.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version)
);

// 迁移按文件名顺序执行；已登记的版本不重复应用。
const migrations = fs
  .readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const insertApplied = database.prepare("INSERT INTO schema_migrations(version) VALUES (?)");

for (const file of migrations) {
  const version = file.replace(/\.sql$/, "");
  if (applied.has(version)) {
    continue;
  }
  const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
  database.exec("BEGIN");
  try {
    database.exec(sql);
    // 早期迁移自行写入过版本号，忽略重复登记。
    try {
      insertApplied.run(version);
    } catch (error) {
      if (!String(error.message).includes("UNIQUE")) {
        throw error;
      }
    }
    database.exec("COMMIT");
    console.log(`已应用迁移：${version}`);
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }
}

database.close();
console.log(`数据库迁移完成：${databasePath}`);
