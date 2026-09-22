'use strict';

const path = require('node:path');
const { openDatabase } = require('./db');
const { Store } = require('./store');
const { createServer } = require('./server');

const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'app.sqlite3');
const port = Number.parseInt(process.env.PORT || '8080', 10);

const db = openDatabase(databasePath);
const server = createServer({ store: new Store(db) });

server.listen(port, '0.0.0.0', () => {
  console.log(`展陈发布中心已启动：http://0.0.0.0:${port}（数据库 ${databasePath}）`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
