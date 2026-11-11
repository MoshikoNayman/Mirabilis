// @ts-check
// /api/access: the Access level and always-allowed commands. Privileged, because a
// higher level lets agent runs change this computer.

import express, { Router } from 'express';

import { READ_ONLY_PROGRAMS } from '../agent/commandPolicy.js';
import { ACCESS_LEVELS, ACCESS_META } from '../agent/permissions.js';
import { isGoDark } from '../egress.js';

/** Programs commandPolicy.js treats as read-only on Windows. */
const WINDOWS_READ_ONLY_PROGRAMS = [
  'dir', 'findstr', 'hostname', 'ipconfig', 'netstat', 'nslookup', 'ping', 'systeminfo',
  'tasklist', 'tracert', 'type', 'ver', 'where', 'whoami'
];

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../accessSettings.js').createAccessStore>} deps.store
 * @param {import('express').RequestHandler} deps.guard  the privileged-route guard
 * @param {string} deps.sourceRoot
 * @param {string} deps.dataDir
 * @param {string} [deps.platform]
 * @param {() => boolean} [deps.goDark]
 */
export function createAccessRouter({ store, guard, sourceRoot, dataDir, platform = process.platform, goDark = isGoDark }) {
  if (typeof guard !== 'function') throw new TypeError('createAccessRouter needs the privileged guard.');
  const router = Router();
  // Guard first: an unauthenticated caller gets nothing parsed.
  router.use(guard);
  router.use(express.json({ limit: '64kb' }));

  const view = () => {
    const s = store.get();
    return {
      level: s.level,
      levels: ACCESS_LEVELS.map((id) => ({ id, label: ACCESS_META[id].label, summary: ACCESS_META[id].summary })),
      allowCommands: s.allowCommands,
      readOnlyPrograms: platform === 'win32' ? WINDOWS_READ_ONLY_PROGRAMS : READ_ONLY_PROGRAMS,
      goDark: Boolean(goDark()),
      sourceRoot,
      dataDir,
      updatedAt: s.updatedAt
    };
  };

  router.get('/', (_req, res) => {
    res.json(view());
  });

  router.put('/', async (req, res) => {
    try {
      await store.set(req.body);
      res.json(view());
    } catch (err) {
      if (err?.name === 'AccessSettingsError') {
        res.status(400).json({ error: String(err.message) });
        return;
      }
      res.status(500).json({ error: `Could not save the Access settings: ${String(err?.message || err)}` });
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
