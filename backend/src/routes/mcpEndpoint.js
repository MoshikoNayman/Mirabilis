// @ts-check
// /api/mcp-endpoint: turn Mirabilis's own MCP server (POST /mcp) on or off.
// Privileged, because that server can write files and run commands.

import express, { Router } from 'express';

import { MCP_TOOL_NAMES } from '../mcp/mcpServer.js';

export const MCP_PATH = '/mcp';
export const MCP_OFF_ERROR = 'Mirabilis MCP server is off';

/**
 * 503 while the server is off. Mounted ahead of the token check, so a client
 * hears that it is off rather than that its token is wrong.
 * @param {{isEnabled: () => boolean}} store
 * @returns {import('express').RequestHandler}
 */
export function makeMcpEndpointGate(store) {
  return function mcpEndpointGate(_req, res, next) {
    if (store.isEnabled()) {
      next();
      return;
    }
    res.status(503).json({ error: MCP_OFF_ERROR });
  };
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../mcpEndpoint.js').createMcpEndpointStore>} deps.store
 * @param {import('express').RequestHandler} deps.guard  the privileged-route guard
 * @param {readonly string[]} [deps.tools]  tool names the server offers
 */
export function createMcpEndpointRouter({ store, guard, tools = MCP_TOOL_NAMES }) {
  if (typeof guard !== 'function') throw new TypeError('createMcpEndpointRouter needs the privileged guard.');
  const router = Router();
  // Guard first: an unauthenticated caller gets nothing parsed.
  router.use(guard);
  router.use(express.json({ limit: '16kb' }));

  const view = () => ({ enabled: store.get().enabled, path: MCP_PATH, tools: [...tools] });

  router.get('/', (_req, res) => {
    res.json(view());
  });

  router.put('/', async (req, res) => {
    try {
      await store.set(req.body);
      res.json(view());
    } catch (err) {
      if (err?.name === 'McpEndpointError') {
        res.status(400).json({ error: String(err.message) });
        return;
      }
      res.status(500).json({ error: `Could not save the MCP server setting: ${String(err?.message || err)}` });
    }
  });

  // Malformed JSON and oversized bodies answer in the same plain shape.
  router.use((/** @type {any} */ err, /** @type {any} */ _req, /** @type {any} */ res, /** @type {any} */ next) => {
    if (res.headersSent) { next(err); return; }
    if (err?.type === 'entity.parse.failed') { res.status(400).json({ error: 'The request body is not valid JSON.' }); return; }
    if (err?.type === 'entity.too.large') { res.status(400).json({ error: 'The request body is too large.' }); return; }
    res.status(500).json({ error: `Something went wrong: ${String(err?.message || err)}` });
  });

  return router;
}
