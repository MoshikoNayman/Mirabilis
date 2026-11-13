// The gate is where the access level becomes an allow / ask / deny verdict.
import test from 'node:test';
import assert from 'node:assert/strict';

import { decide, normalizeLevel, lowerLevel, ACCESS_LEVELS, ACCESS_META } from './permissions.js';

const base = {
  runRules: { allowWrites: false, commandRules: [], connectorTools: [] },
  allowCommands: [],
  goDark: false,
  platform: 'darwin'
};

const call = (over) => decide({ ...base, ...over });

test('levels, meta and helpers are consistent', () => {
  assert.deepEqual(ACCESS_LEVELS, ['chat', 'read', 'ask', 'bypass']);
  for (const id of ACCESS_LEVELS) {
    assert.ok(ACCESS_META[id].label);
  }
  assert.equal(normalizeLevel('nope'), 'chat');
  assert.equal(normalizeLevel(undefined), 'chat');
  assert.equal(normalizeLevel('bypass'), 'bypass');
  assert.equal(lowerLevel('bypass', 'read'), 'read');
  assert.equal(lowerLevel('ask', 'bypass'), 'ask');
  assert.equal(lowerLevel('chat', 'ask'), 'chat');
  assert.equal(lowerLevel('ask', 'garbage'), 'chat', 'an unknown level normalizes to chat and wins');
});

test('chat denies every tool', () => {
  for (const kind of ['read', 'write', 'command', 'connector', 'internal']) {
    const v = call({ level: 'chat', tool: 't', args: {}, info: { kind } });
    assert.equal(v.action, 'deny');
    assert.match(v.reason, /Chat only/);
  }
});

test('read-only and internal tools run in read and ask', () => {
  for (const level of ['read', 'ask', 'bypass']) {
    assert.equal(call({ level, tool: 'read_file', args: {}, info: { kind: 'read' } }).action, 'allow');
    assert.equal(call({ level, tool: 'x', args: {}, info: { kind: 'internal' } }).action, 'allow');
  }
});

// writes

test('read denies writes; ask asks then can be made to allow', () => {
  const deny = call({ level: 'read', tool: 'write_file', args: { path: 'a', content: 'x' }, info: { kind: 'write' } });
  assert.equal(deny.action, 'deny');
  assert.match(deny.reason, /Read only/);

  const ask = call({ level: 'ask', tool: 'write_file', args: { path: 'a.txt', content: 'hello\nworld' }, info: { kind: 'write' } });
  assert.equal(ask.action, 'ask');
  assert.equal(ask.request.kind, 'write');
  assert.equal(ask.request.reasonCode, 'changes-files');
  assert.deepEqual(ask.request.alwaysRule, { type: 'writes' });
  assert.equal(ask.request.alwaysLabel, 'Allow for this run');
  assert.match(ask.request.detail, /a\.txt/);
  assert.match(ask.request.detail, /hello/);

  const allowed = call({
    level: 'ask', tool: 'write_file', args: { path: 'a', content: 'x' }, info: { kind: 'write' },
    runRules: { allowWrites: true, commandRules: [], connectorTools: [] }
  });
  assert.equal(allowed.action, 'allow', 'a run-scoped write grant skips the prompt');
});

test('edit_file approval shows a compact diff', () => {
  const v = call({ level: 'ask', tool: 'edit_file', args: { path: 'f.js', old: 'const a = 1', new: 'const a = 2' }, info: { kind: 'write' } });
  assert.equal(v.request.title, 'Edit a file');
  assert.match(v.request.detail, /- const a = 1/);
  assert.match(v.request.detail, /\+ const a = 2/);
});

test('bypass allows writes with no prompt', () => {
  const v = call({ level: 'bypass', tool: 'write_file', args: { path: 'a', content: 'x' }, info: { kind: 'write' } });
  assert.equal(v.action, 'allow');
});

// commands

test('read allows read-only commands and denies the rest', () => {
  assert.equal(call({ level: 'read', tool: 'run_command', args: { command: 'ls -la' }, info: { kind: 'command' } }).action, 'allow');
  const deny = call({ level: 'read', tool: 'run_command', args: { command: 'rm x' }, info: { kind: 'command' } });
  assert.equal(deny.action, 'deny');
  assert.match(deny.reason, /may change things/);
});

test('ask auto-allows read-only, asks on a write, and offers an always rule', () => {
  assert.equal(call({ level: 'ask', tool: 'run_command', args: { command: 'git status' }, info: { kind: 'command' } }).action, 'allow');

  const ask = call({ level: 'ask', tool: 'run_command', args: { command: 'npm install' }, info: { kind: 'command' } });
  assert.equal(ask.action, 'ask');
  assert.equal(ask.request.kind, 'command');
  assert.equal(ask.request.reasonCode, 'not-read-only');
  assert.equal(ask.request.detail, 'npm install');
  assert.deepEqual(ask.request.alwaysRule, { type: 'command', rule: 'npm install' });
  assert.match(ask.request.alwaysLabel, /Always allow/);
});

test('an allow rule, persisted or run-scoped, auto-allows a matching command in ask', () => {
  assert.equal(call({
    level: 'ask', tool: 'run_command', args: { command: 'npm install' }, info: { kind: 'command' },
    allowCommands: ['npm install']
  }).action, 'allow');
  assert.equal(call({
    level: 'ask', tool: 'run_command', args: { command: 'make build' }, info: { kind: 'command' },
    runRules: { allowWrites: false, commandRules: ['make'], connectorTools: [] }
  }).action, 'allow');
});

test('Go Dark pauses network commands even when they are read-only', () => {
  const readDeny = call({ level: 'read', tool: 'run_command', args: { command: 'ping -c 1 host' }, info: { kind: 'command' }, goDark: true });
  assert.equal(readDeny.action, 'deny');
  assert.match(readDeny.reason, /Go Dark/);

  const askNet = call({ level: 'ask', tool: 'run_command', args: { command: 'ping -c 1 host' }, info: { kind: 'command' }, goDark: true });
  assert.equal(askNet.action, 'ask');
  assert.equal(askNet.request.reasonCode, 'network-go-dark');
  assert.match(askNet.request.reason, /Go Dark is on/);
  assert.equal(askNet.request.alwaysRule, null, 'no always rule for a network command under Go Dark');
  assert.equal(askNet.request.alwaysLabel, null);
  assert.equal(askNet.request.network, true);

  // Without Go Dark the same command is allowed read-only.
  assert.equal(call({ level: 'ask', tool: 'run_command', args: { command: 'ping -c 1 host' }, info: { kind: 'command' } }).action, 'allow');
});

test('bypass runs any command', () => {
  assert.equal(call({ level: 'bypass', tool: 'run_command', args: { command: 'rm -rf x' }, info: { kind: 'command' } }).action, 'allow');
});

// connectors

test('connector off is denied at every level', () => {
  for (const level of ['read', 'ask', 'bypass']) {
    const v = call({ level, tool: 'c__t', args: {}, info: { kind: 'connector', permission: 'off', readOnly: true, connectorName: 'C', mcpTool: 't' } });
    assert.equal(v.action, 'deny', `off must deny in ${level}`);
  }
});

test('read allows only read-only connector tools', () => {
  assert.equal(call({ level: 'read', tool: 'c__t', args: {}, info: { kind: 'connector', permission: 'allow', readOnly: true, connectorName: 'C', mcpTool: 't' } }).action, 'allow');
  const deny = call({ level: 'read', tool: 'c__w', args: {}, info: { kind: 'connector', permission: 'allow', readOnly: false, connectorName: 'C', mcpTool: 'w' } });
  assert.equal(deny.action, 'deny');
});

test('ask allows connector tools marked allow or granted, asks otherwise', () => {
  assert.equal(call({ level: 'ask', tool: 'c__t', args: {}, info: { kind: 'connector', permission: 'allow', readOnly: true, connectorName: 'C', mcpTool: 't' } }).action, 'allow');

  const ask = call({ level: 'ask', tool: 'c__w', args: { a: 1 }, info: { kind: 'connector', permission: 'ask', readOnly: false, connectorName: 'Files', mcpTool: 'write_file' } });
  assert.equal(ask.action, 'ask');
  assert.equal(ask.request.kind, 'connector');
  assert.equal(ask.request.reasonCode, 'connector-ask');
  assert.equal(ask.request.title, 'Use Files: write_file');
  assert.deepEqual(ask.request.alwaysRule, { type: 'connector', tool: 'c__w' });

  assert.equal(call({
    level: 'ask', tool: 'c__w', args: {}, info: { kind: 'connector', permission: 'ask', readOnly: false, connectorName: 'Files', mcpTool: 'write_file' },
    runRules: { allowWrites: false, commandRules: [], connectorTools: ['c__w'] }
  }).action, 'allow', 'a run-scoped connector grant auto-allows');
});
