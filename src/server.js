'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { Store } = require('./store');
const { ApiError, ValidationError } = require('./errors');
const { resolveAt } = require('./time');

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return {};
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return {};
  try {
    const body = JSON.parse(raw);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ValidationError('请求体必须是 JSON 对象');
    }
    return body;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError('请求体不是合法 JSON');
    }
    throw error;
  }
}

function createServer(options = {}) {
  const store = options.store || new Store(options.db);

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      const parts = pathname.split('/').slice(1);
      const body = await readJson(request);
      const query = Object.fromEntries(url.searchParams);
      await route(request.method, parts, query, body, response);
    } catch (error) {
      if (error instanceof ApiError) {
        send(response, error.status, { error: error.error, message: error.message });
      } else {
        send(response, 500, { error: 'internal_error', message: error.message });
      }
    }
  });

  async function route(method, parts, query, body, response) {
    // GET /health
    if (method === 'GET' && parts.length === 1 && parts[0] === 'health') {
      return send(response, 200, { status: 'ok' });
    }

    // 观众端：当前有效版本
    if (method === 'GET' && parts.length === 2 && parts[0] === 'public' && parts[1] === 'exhibition') {
      return send(response, 200, store.publicExhibition());
    }

    // 内部：历史复原
    if (method === 'GET' && parts.length === 2 && parts[0] === 'internal' && parts[1] === 'snapshot') {
      return send(response, 200, store.historicalSnapshot(resolveAt(query.at)));
    }

    if (parts[0] === 'v1') {
      return routeV1(method, parts.slice(1), query, body, response);
    }
    return send(response, 404, { error: 'not_found' });
  }

  function routeV1(method, p, query, body, response) {
    // /v1/objects[/...]
    if (p[0] === 'objects') {
      if (p.length === 1) {
        if (method === 'POST') return send(response, 201, store.registerObject(body));
        if (method === 'GET') return send(response, 200, { objects: store.listObjects() });
      }
      const ref = decodeURIComponent(p[1] || '');
      if (p.length === 2) {
        if (method === 'GET') return send(response, 200, store.getObject(ref));
      }
      if (p.length === 3 && p[2] === 'status-events') {
        if (method === 'POST') return send(response, 201, store.recordStatusEvent(ref, body));
        if (method === 'GET') return send(response, 200, { events: store.listStatusEvents(ref) });
      }
      if (p.length === 3 && p[2] === 'labels') {
        if (method === 'POST') return send(response, 201, store.proposeLabel(ref, body));
        if (method === 'GET') return send(response, 200, { revisions: store.listLabels(ref) });
      }
    }

    // /v1/labels/:id/publish
    if (p[0] === 'labels' && p.length === 3 && p[2] === 'publish' && method === 'POST') {
      return send(response, 200, store.publishLabel(Number.parseInt(p[1], 10), body));
    }

    // /v1/narratives
    if (p[0] === 'narratives' && p.length === 1) {
      if (method === 'POST') return send(response, 201, store.createNarrative(body));
      if (method === 'GET') return send(response, 200, { narratives: store.listNarratives() });
    }

    // /v1/channels[/...]
    if (p[0] === 'channels') {
      if (p.length === 1) {
        if (method === 'POST') return send(response, 201, store.createChannel(body));
        if (method === 'GET') return send(response, 200, { channels: store.listChannels() });
      }
      if (p.length === 3 && p[2] === 'layouts') {
        const channelRef = decodeURIComponent(p[1]);
        if (method === 'POST') return send(response, 201, store.addLayout(channelRef, body));
        if (method === 'GET') return send(response, 200, { layouts: store.listLayouts(channelRef) });
      }
    }

    // /v1/placements[/...]
    if (p[0] === 'placements') {
      if (p.length === 1) {
        if (method === 'POST') return send(response, 201, store.proposePlacement(body));
        if (method === 'GET') return send(response, 200, { placements: store.listPlacements(query) });
      }
      if (p.length === 2 && method === 'GET') {
        return send(response, 200, store.getPlacement(decodeURIComponent(p[1])));
      }
      if (p.length === 3) {
        const ref = decodeURIComponent(p[1]);
        switch (p[2]) {
          case 'approve':
            requirePost(method);
            return send(response, 200, store.approvePlacement(ref));
          case 'reject':
            requirePost(method);
            return send(response, 200, store.rejectPlacement(ref, body));
          case 'publish':
            requirePost(method);
            return send(response, 200, store.publishPlacement(ref, body));
          case 'withdraw':
            requirePost(method);
            return send(response, 200, store.withdrawPlacement(ref, body));
          default:
            break;
        }
      }
    }

    return send(response, 404, { error: 'not_found' });
  }

  function requirePost(method) {
    if (method !== 'POST') throw new ValidationError('该操作需要 POST 请求');
  }

  return server;
}

module.exports = { createServer };
