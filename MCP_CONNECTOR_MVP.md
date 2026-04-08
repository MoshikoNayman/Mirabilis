# Mirabilis Generic MCP Connector (MVP)

This document defines the minimal backend and API contract to connect Mirabilis to any streamable MCP server.

## Scope

- Generic MCP client integration for `streamable-http` servers.
- Server registry in backend (file-backed).
- Tool discovery and tool invocation endpoints.
- Frontend MCP manager dropdown in chat composer.
- Per-server tool policy (allowlist + approval requirement).

## Current Backend Artifacts

- Connector service: `backend/src/mcp/mcpConnectorService.js`
- HTTP routes: `backend/src/server.js` under `/api/mcp/*`
- Registry store file: `<chat-store-dir>/mcp-servers.json`

## Supported Transport

- `streamable-http` only (HTTP/HTTPS JSON-RPC over POST)
- Future transports can be added:
  - stdio
  - SSE

## Backend API Contract

### List servers

- `GET /api/mcp/servers`
- Response:

```json
{
  "servers": [
    {
      "id": "lab-main",
      "name": "Lab MCP",
      "url": "http://127.0.0.1:30030/mcp",
      "transport": "streamable-http",
      "enabled": true,
      "hasAuthToken": false,
      "createdAt": "2026-04-06T10:00:00.000Z",
      "updatedAt": "2026-04-06T10:00:00.000Z"
    }
  ]
}
```

### Create server

- `POST /api/mcp/servers`
- Body:

```json
{
  "id": "lab-main",
  "name": "Lab MCP",
  "url": "http://127.0.0.1:30030/mcp",
  "transport": "streamable-http",
  "enabled": true,
  "authToken": "optional-bearer-token"
}
```

### Update server

- `PUT /api/mcp/servers/:id`
- Body:

```json
{
  "name": "Lab MCP",
  "url": "http://127.0.0.1:30030/mcp",
  "transport": "streamable-http",
  "enabled": true,
  "authToken": "optional-bearer-token"
}
```

### Delete server

- `DELETE /api/mcp/servers/:id`

### Test server

- `POST /api/mcp/servers/:id/test`
- Body (optional):

```json
{
  "timeoutMs": 15000
}
```

- Success response:

```json
{
  "ok": true,
  "server": {
    "id": "lab-main",
    "name": "Lab MCP",
    "url": "http://127.0.0.1:30030/mcp",
    "transport": "streamable-http",
    "enabled": true,
    "hasAuthToken": false,
    "createdAt": "2026-04-06T10:00:00.000Z",
    "updatedAt": "2026-04-06T10:00:00.000Z"
  },
  "initialize": {},
  "checkedAt": "2026-04-06T10:00:01.000Z"
}
```

### List tools

- `POST /api/mcp/servers/:id/tools/list`
- Body (optional):

```json
{
  "timeoutMs": 15000
}
```

- Response:

```json
{
  "tools": [
    {
      "name": "list_entities",
      "description": "List available entities"
    }
  ],
  "raw": {
    "tools": []
  }
}
```

### Call tool

- `POST /api/mcp/servers/:id/tools/call`
- Body:

```json
{
  "name": "list_entities",
  "arguments": {},
  "approvalToken": "optional-if-policy-requires",
  "timeoutMs": 30000
}
```

- Response:

```json
{
  "result": {}
}
```

### Read policy

- `GET /api/mcp/servers/:id/policy`
- Response:

```json
{
  "policy": {
    "enforceAllowlist": false,
    "requireApproval": true,
    "approvalTtlSeconds": 300,
    "allowedTools": []
  }
}
```

### Update policy

- `PUT /api/mcp/servers/:id/policy`
- Body:

```json
{
  "enforceAllowlist": true,
  "requireApproval": true,
  "approvalTtlSeconds": 300,
  "allowedTools": ["list_entities", "read_entity"]
}
```

### Request approval token

- `POST /api/mcp/servers/:id/tools/request-approval`
- Body:

```json
{
  "name": "list_entities",
  "arguments": {}
}
```

- Response:

```json
{
  "ok": true,
  "approvalToken": "uuid-token",
  "expiresAt": "2026-04-06T11:00:00.000Z",
  "policy": {
    "enforceAllowlist": false,
    "requireApproval": true,
    "approvalTtlSeconds": 300,
    "allowedTools": []
  }
}
```
```

## Validation Rules (MVP)

- `id` required, string, unique.
- `name` required.
- `url` required, valid `http`/`https`.
- `transport` must be `streamable-http`.
- `arguments` for tool call must be an object.

## Security Baseline (MVP)

- Optional bearer token per server (`authToken`).
- Disabled servers cannot be tested/called.
- Timeout clamps on all test/tool operations.
- Optional per-server allowlist enforcement.
- Optional per-call approval token requirement with TTL.
- Audit log is written to `<chat-store-dir>/mcp-audit.jsonl`.
- Audit records avoid raw arguments and store argument hash + key summary.

## Recommended Next Steps

1. Add audit log for MCP tool calls and approvals.
2. Add tool argument schema form-generation in frontend.
3. Add stdio transport support.
4. Add per-user approval flows (multi-user sessions).
