// @ts-check
// /api/connectors: add, configure and run MCP connectors. Privileged, because a
// connector is a local program this backend starts.

import express, { Router } from 'express';

/** @typedef {ReturnType<typeof import('../mcp/connectors.js').createConnectorManager>} ConnectorManager */

/**
 * @param {any} err
 * @returns {{status: number, message: string}}
 */
function describeError(err) {
  if (err?.type === 'entity.parse.failed') return { status: 400, message: 'The request body is not valid JSON.' };
  if (err?.type === 'entity.too.large') return { status: 400, message: 'The request body is too large.' };
  const status = Number(err?.status);
  if (err?.name === 'ConnectorError' && (status === 400 || status === 404)) return { status, message: String(err.message) };
  if (err?.name === 'ConnectorError') return { status: 500, message: String(err.message) };
  return { status: 500, message: `Something went wrong: ${String(err?.message || err)}` };
}

/** @param {any} body */
function objectBody(body) {
  if (body == null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Send a JSON object.'), { name: 'ConnectorError', status: 400 });
  }
  return body;
}

/**
 * @param {object} deps
 * @param {ConnectorManager} deps.manager
 * @param {import('express').RequestHandler} deps.guard  the privileged-route guard
 */
export function createConnectorsRouter({ manager, guard }) {
  if (typeof guard !== 'function') throw new TypeError('createConnectorsRouter needs the privileged guard.');
  const router = Router();
  // Guard first: an unauthenticated caller gets nothing parsed or started.
  router.use(guard);
  router.use(express.json({ limit: '256kb' }));

  /** @param {(req: any, res: any) => Promise<void>} fn */
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const { status, message } = describeError(err);
      if (!res.headersSent) res.status(status).json({ error: message });
    }
  };

  router.get('/', handle(async (_req, res) => {
    await manager.init();
    res.json({ connectors: manager.list() });
  }));

  router.get('/catalog', handle(async (_req, res) => {
    await manager.init();
    res.json({ presets: manager.catalog() });
  }));

  router.post('/', handle(async (req, res) => {
    const connector = await manager.create(objectBody(req.body));
    res.status(201).json({ connector });
  }));

  router.get('/:id', handle(async (req, res) => {
    await manager.init();
    const connector = manager.get(req.params.id);
    if (!connector) {
      res.status(404).json({ error: 'Connector not found.' });
      return;
    }
    res.json({ connector });
  }));

  router.patch('/:id', handle(async (req, res) => {
    res.json({ connector: await manager.update(req.params.id, objectBody(req.body)) });
  }));

  router.delete('/:id', handle(async (req, res) => {
    await manager.remove(req.params.id);
    res.json({ ok: true });
  }));

  router.post('/:id/restart', handle(async (req, res) => {
    res.json({ connector: await manager.restart(req.params.id) });
  }));

  router.get('/:id/logs', handle(async (req, res) => {
    await manager.init();
    res.json({ lines: manager.logs(req.params.id) });
  }));

  // A click in the app is the approval, so 'ask' tools run; 'off' tools never do.
  router.post('/:id/tools/:tool/call', handle(async (req, res) => {
    const body = objectBody(req.body);
    const result = await manager.callTool(req.params.id, req.params.tool, body.args === undefined ? {} : body.args);
    res.json({ result: { text: result.text, isError: result.isError } });
  }));

  // Body-parser failures arrive here instead of the handlers above.
  router.use((err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const { status, message } = describeError(err);
    res.status(status).json({ error: message });
  });

  return router;
}
