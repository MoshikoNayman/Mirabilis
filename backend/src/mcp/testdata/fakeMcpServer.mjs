// Minimal MCP server over stdio for tests: two tools over two tools/list pages.
// FAKE_MCP_MODE picks a misbehavior: fail, grandchild, stubborn, ping.

import { spawn } from 'node:child_process';
import readline from 'node:readline';

const mode = process.env.FAKE_MCP_MODE || '';

if (mode === 'fail') {
  process.stderr.write('fatal: missing config file\n');
  process.exit(2);
}

const TOOLS = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Returns the text it is given.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to return' },
        repeat: { type: 'number', description: 'How many times to repeat it' }
      },
      required: ['text']
    }
  },
  {
    name: 'write_note',
    description: 'Saves a note.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] }
  }
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const answer = (id, result) => send({ jsonrpc: '2.0', id, result });

process.stderr.write('fake server ready\n');
if (process.env.FAKE_MCP_SECRET) process.stderr.write(`using key ${process.env.FAKE_MCP_SECRET}\n`);
if (process.env.OPENAI_API_KEY) process.stderr.write('leaked OPENAI_API_KEY\n');

if (mode === 'grandchild') {
  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.stderr.write(`grandchild pid ${kid.pid}\n`);
}
if (mode === 'stubborn') {
  process.on('SIGTERM', () => process.stderr.write('ignoring SIGTERM\n'));
  setInterval(() => {}, 1000);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === 'srv-ping' && 'result' in msg) {
    process.stderr.write('got pong\n');
    return;
  }
  switch (msg.method) {
    case 'initialize':
      answer(msg.id, {
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fake-mcp', version: '1.2.3' }
      });
      return;
    case 'notifications/initialized':
      if (mode === 'ping') send({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' });
      return;
    case 'notifications/cancelled':
      process.stderr.write(`cancelled ${msg.params?.requestId}\n`);
      return;
    case 'tools/list':
      if (msg.params?.cursor === 'page-2') answer(msg.id, { tools: [TOOLS[1]] });
      else answer(msg.id, { tools: [TOOLS[0]], nextCursor: 'page-2' });
      return;
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params || {};
      if (name === 'echo') {
        if (args.text === '__crash__') {
          process.stderr.write('crashing on purpose\n');
          process.exit(1);
        }
        if (args.text === '__hang__') return;
        if (args.text === '__fail__') {
          answer(msg.id, { content: [{ type: 'text', text: 'it went wrong' }], isError: true });
          return;
        }
        answer(msg.id, { content: [{ type: 'text', text: String(args.text ?? '').repeat(Number(args.repeat) || 1) }] });
        return;
      }
      if (name === 'write_note') {
        answer(msg.id, {
          content: [
            { type: 'text', text: `Saved: ${args.note}` },
            { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
            { type: 'resource_link', uri: 'file:///notes/1', name: 'note' }
          ]
        });
        return;
      }
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      return;
    }
    default:
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } });
  }
});
// Stdio servers exit when the client closes stdin; the stubborn one does not.
rl.on('close', () => {
  if (mode !== 'stubborn') process.exit(0);
});
