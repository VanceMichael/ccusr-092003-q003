
const http = require("node:http");
const path = require("node:path");
const { openDatabase } = require("./lib/db");
const { Store, DomainError } = require("./lib/store");
const { parseInstant, formatWithOffset } = require("./lib/time");

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new DomainError("validation", "请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new DomainError("validation", "请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

const ERROR_STATUS = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  invalid_state: 409,
};

function createServer(options = {}) {
  const databasePath =
    options.databasePath || process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
  const db = openDatabase(databasePath);
  const clock = options.clock || (() => Date.now());
  const store = new Store(db, { clock });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const pathname = url.pathname;

    function match(pattern) {
      const parts = pathname.split("/").filter(Boolean);
      const pats = pattern.split("/").filter(Boolean);
      if (parts.length !== pats.length) {
        return null;
      }
      const params = {};
      for (let i = 0; i < pats.length; i += 1) {
        if (pats[i].startsWith(":")) {
          params[pats[i].slice(1)] = decodeURIComponent(parts[i]);
        } else if (pats[i] !== parts[i]) {
          return null;
        }
      }
      return params;
    }

    try {
      // 健康
      if (request.method === "GET" && pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      // 观众视图：始终读取当前有效版本
      if (request.method === "GET" && pathname === "/public/now") {
        sendJson(response, 200, store.viewAt(formatWithOffset(new Date(clock()))));
        return;
      }

      // 内部历史复原：任给日期，复原当日展柜、文献与数字页面对应
      if (request.method === "GET" && pathname === "/internal/as-of") {
        const at = url.searchParams.get("at");
        if (!at) {
          throw new DomainError("validation", "查询参数 at 必填（带偏移量的 ISO 8601 时刻）");
        }
        parseInstant(at);
        sendJson(response, 200, store.asOf(at));
        return;
      }

      // 审阅队列
      if (request.method === "GET" && pathname === "/v1/review-queue") {
        sendJson(response, 200, store.reviewQueue());
        return;
      }

      // 展品
      if (request.method === "POST" && pathname === "/v1/objects") {
        sendJson(response, 201, store.createObject(await readJsonBody(request)));
        return;
      }
      if (request.method === "GET" && pathname === "/v1/objects") {
        sendJson(response, 200, { objects: store.listObjects() });
        return;
      }
      let params;
      if ((params = match("/v1/objects/:ref")) && request.method === "GET") {
        sendJson(response, 200, store.getObject(params.ref));
        return;
      }
      if ((params = match("/v1/objects/:ref/custody")) && request.method === "POST") {
        const body = await readJsonBody(request);
        sendJson(response, 201, store.recordCustody({ ...body, object_ref: params.ref }));
        return;
      }
      if ((params = match("/v1/objects/:ref/custody")) && request.method === "GET") {
        sendJson(response, 200, { custody_events: store.listCustody(params.ref) });
        return;
      }

      // 年代更正
      if (request.method === "POST" && pathname === "/v1/corrections") {
        sendJson(response, 201, store.createCorrection(await readJsonBody(request)));
        return;
      }
      if (request.method === "GET" && pathname === "/v1/corrections") {
        sendJson(response, 200, { corrections: store.listCorrections(url.searchParams.get("status")) });
        return;
      }
      if ((params = match("/v1/corrections/:id")) && request.method === "GET") {
        sendJson(response, 200, store.getCorrection(params.id));
        return;
      }
      if ((params = match("/v1/corrections/:id/submit")) && request.method === "POST") {
        sendJson(response, 200, store.submitCorrection(params.id, await readJsonBody(request)));
        return;
      }
      if ((params = match("/v1/corrections/:id/review")) && request.method === "POST") {
        const body = await readJsonBody(request);
        sendJson(response, 200, store.reviewCorrection(params.id, body.decision, body));
        return;
      }

      // 展签
      if (request.method === "POST" && pathname === "/v1/labels") {
        sendJson(response, 201, store.draftLabel(await readJsonBody(request)));
        return;
      }
      if (request.method === "GET" && pathname === "/v1/labels") {
        sendJson(response, 200, { labels: store.listLabels(url.searchParams.get("object_ref")) });
        return;
      }
      if ((params = match("/v1/labels/:id")) && request.method === "GET") {
        sendJson(response, 200, store.getLabel(params.id));
        return;
      }
      if ((params = match("/v1/labels/:id/submit")) && request.method === "POST") {
        sendJson(response, 200, store.submitLabel(params.id, await readJsonBody(request)));
        return;
      }
      if ((params = match("/v1/labels/:id/review")) && request.method === "POST") {
        const body = await readJsonBody(request);
        sendJson(response, 200, store.reviewLabel(params.id, body.decision, body));
        return;
      }

      // 叙事
      if (request.method === "POST" && pathname === "/v1/narratives") {
        sendJson(response, 201, store.createNarrative(await readJsonBody(request)));
        return;
      }
      if (request.method === "GET" && pathname === "/v1/narratives") {
        sendJson(response, 200, { narratives: store.listNarratives() });
        return;
      }

      // 展面
      if (request.method === "POST" && pathname === "/v1/surfaces") {
        sendJson(response, 201, store.createSurface(await readJsonBody(request)));
        return;
      }
      if (request.method === "GET" && pathname === "/v1/surfaces") {
        sendJson(response, 200, { surfaces: store.listSurfaces() });
        return;
      }

      // 排期 / 替代展项
      if (request.method === "POST" && pathname === "/v1/placements") {
        sendJson(response, 201, store.createPlacement(await readJsonBody(request)));
        return;
      }
      if (request.method === "GET" && pathname === "/v1/placements") {
        sendJson(
          response,
          200,
          {
            placements: store.listPlacements({
              surface_ref: url.searchParams.get("surface_ref") || undefined,
              object_ref: url.searchParams.get("object_ref") || undefined,
              status: url.searchParams.get("status") || undefined,
            }),
          }
        );
        return;
      }
      if ((params = match("/v1/placements/:id")) && request.method === "GET") {
        sendJson(response, 200, store.getPlacement(params.id));
        return;
      }
      if ((params = match("/v1/placements/:id/review")) && request.method === "POST") {
        const body = await readJsonBody(request);
        sendJson(response, 200, store.reviewPlacement(Number(params.id), body.decision, body));
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof DomainError || (error && ERROR_STATUS[error.code])) {
        sendJson(response, ERROR_STATUS[error.code] || 400, {
          error: error.code || "validation",
          message: error.message,
        });
        return;
      }
      sendJson(response, 500, { error: "internal", message: error.message });
    }
  });

  server.on("close", () => db.close());
  return server;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`展陈发布中心监听 0.0.0.0:${port}`);
  });
}

module.exports = { createServer };
