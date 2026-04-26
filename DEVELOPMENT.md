# Mirabilis Development Guide

**Last Updated:** April 26, 2026

---

## Quick Start

### Project Structure
- **Source:** `/Users/mnayman/Downloads/mirabilis/` (55MB, where you edit)
- **Runtime:** `/Users/mnayman/Downloads/mirabilis-runtime/` (1.1GB with node_modules, where you run)
- **Data:** `/Users/mnayman/Downloads/mirabilis-data/` (external, resolved via `MIRABILIS_DATA_DIR` env var)

### Sync Workflow
After editing code in `/mirabilis/backend/src/`, sync to runtime before testing:

```bash
# From /Users/mnayman/Downloads, sync backend
rsync -av --delete mirabilis/backend/src/ mirabilis-runtime/backend/src/

# Or alias it
alias sync_mirabilis='rsync -av --delete /Users/mnayman/Downloads/mirabilis/backend/src/ /Users/mnayman/Downloads/mirabilis-runtime/backend/src/ && echo "✓ Synced"'
```

Then restart:
```bash
pkill -f "node backend/src/server.js"
cd /Users/mnayman/Downloads/mirabilis-runtime
node backend/src/server.js
```

---

## Intelledger Module

Located in `backend/src/routes/intelLedger.js` and `backend/src/storage/intelLedger.js`

### Bug Fixes Applied

#### 1. Invalid Date Validation (lines 157–166)
**Issue:** `extractDueDate()` accepted impossible dates like "2026-13-45"  
**Fix:** Added ISO validation check using `new Date()` with `isNaN()`:
```javascript
const candidate = extractedDate;
const dateObj = new Date(candidate + 'T00:00:00Z');
if (isNaN(dateObj.getTime())) {
  return null; // Reject invalid dates
}
```
**Test:** Signal "confirm by 2026-13-45" now correctly rejects the malformed date

#### 2. Action PATCH Enum Validation (lines 2312–2329)
**Issue:** Enum fields (`priority`, `status`) accepted invalid values  
**Fix:** Added validation sets, return 400 on bad enum:
```javascript
const VALID_PRIORITY = new Set(['low', 'medium', 'high']);
const VALID_STATUS = new Set(['open', 'in_progress', 'done', 'blocked']);
if (data.priority && !VALID_PRIORITY.has(data.priority)) {
  return res.status(400).json({ error: 'Invalid priority value' });
}
```
**Test:** PATCH with `{"priority":"urgent"}` now returns 400, not 200

#### 3. Text Size Limit (Already Protected)
**Status:** No explicit fix needed  
**Reason:** Ingestion layer protects via `maxTextIngestChars` in config  
**Validation:** Text ingest endpoint enforces character limit before processing

### Features Implemented

#### Feature 1: Action Tagging
**Routes:** Lines 2332–2363

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| POST | `/sessions/:sessionId/actions/:actionId/tags` | `{"tags":["urgent","code-review"]}` | Returns updated action with tags array |
| DELETE | `/sessions/:sessionId/actions/:actionId/tags/:tag` | — | Removes tag, returns updated action |
| GET | `/sessions/:sessionId/actions/by-tag/:tag` | — | Returns `{count, actions}` matching tag |

**Storage:** `action.tags` is an array of lowercase strings, auto-deduped via Set

**Example:**
```bash
# Add tags
curl -X POST http://localhost:4000/api/intelledger/sessions/{sid}/actions/{aid}/tags \
  -H 'Content-Type: application/json' \
  -d '{"tags":["urgent","backend","code-review"]}'

# Filter by tag
curl http://localhost:4000/api/intelledger/sessions/{sid}/actions/by-tag/urgent
```

#### Feature 2: Action Dependencies
**Routes:** Lines 2365–2428

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| POST | `/sessions/:sessionId/actions/:actionId/dependencies` | `{"depends_on":["actionId1","actionId2"]}` | Sets dependencies, returns updated action |
| DELETE | `/sessions/:sessionId/actions/:actionId/dependencies/:depId` | — | Removes dependency, returns updated action |
| GET | `/sessions/:sessionId/actions/:actionId/dependencies` | — | Returns `{action_id, dependencies, blocked}` |

**Validation:**
- Prevents self-reference: "action cannot depend on itself"
- Prevents circular dependencies: uses cycle detection algorithm
- Checks action exists in session before adding

**Storage:** `action.depends_on` array + `action.blocked_by_dependencies` boolean flag

**Blocking Logic:**
- `blocked_by_dependencies = true` if any dependency has status != "done"
- Checked via `isActionBlockedByDependencies()` helper
- Updated on every dependency change

**Example:**
```bash
# Set dependency: action B depends on A
curl -X POST http://localhost:4000/api/intelledger/sessions/{sid}/actions/{bidB}/dependencies \
  -H 'Content-Type: application/json' \
  -d '{"depends_on":["'$AIDA'"]}'

# Check status
curl http://localhost:4000/api/intelledger/sessions/{sid}/actions/{bidB}/dependencies
# Returns: {action_id, dependencies: [{title, status, is_complete}], blocked}
```

### Storage Layer Enhancements

File: `backend/src/storage/intelLedger.js`

**Schema Changes:**
- `action.tags: []` — array of strings
- `action.depends_on: []` — array of action IDs
- `action.blocked_by_dependencies: boolean` — computed flag

**New Helper Functions:**

1. **`getAction(sessionId, actionId)`** (lines 1876–1885)
   - Returns single action or null
   - Used internally for dependency lookups

2. **`isActionBlockedByDependencies(sessionId, actionId)`** (lines 1887–1896)
   - Returns true if any dependency is incomplete
   - Updates `blocked_by_dependencies` flag

3. **`detectCircularDependencies(sessionId, depends_on, excludeId)`** (lines 1898–1920)
   - Cycle detection using visited set + recursion stack
   - Prevents "A→B→C→A" scenarios
   - Called before setting dependencies

**Modified Functions:**

- **`replaceActionsForSession()`** (lines 1737–1759)
  - Now initializes `tags: []`, `depends_on: []`, `blocked_by_dependencies: false` for incoming actions

- **`updateAction()`** (lines 1874–1912)
  - Handles tag merging and deduplication
  - Validates and merges dependency arrays
  - Recalculates blocking status

---

## Testing the Features

### Prerequisites
```bash
cd /Users/mnayman/Downloads/mirabilis-runtime
pkill -f "node backend"
node backend/src/server.js &
sleep 3
```

### End-to-End Test Script
```python
import subprocess, json, time

# Create session
sess = subprocess.run(
    ['curl', '-s', '-X', 'POST', 'http://localhost:4000/api/intelledger/sessions',
     '-H', 'Content-Type: application/json',
     '-d', '{"userId":"test","title":"Feature test"}'],
    capture_output=True, text=True
)
sid = json.loads(sess.stdout)['session']['id']

# Ingest text
subprocess.run(
    ['curl', '-s', '-X', 'POST', f'http://localhost:4000/api/intelledger/sessions/{sid}/ingest/text',
     '-H', 'Content-Type: application/json',
     '-d', '{"content":"Review code. Deploy fix. Notify team."}'],
    capture_output=True
)
time.sleep(1)

# Get actions
actions = subprocess.run(
    ['curl', '-s', f'http://localhost:4000/api/intelledger/sessions/{sid}/actions'],
    capture_output=True, text=True
)
aids = [a['id'] for a in json.loads(actions.stdout)['actions']]

# Test tags
tag = subprocess.run(
    ['curl', '-s', '-X', 'POST', f'http://localhost:4000/api/intelledger/sessions/{sid}/actions/{aids[0]}/tags',
     '-H', 'Content-Type: application/json',
     '-d', '{"tags":["urgent","code-review"]}'],
    capture_output=True, text=True
)
print("Tags:", json.loads(tag.stdout)['action']['tags'])

# Test dependencies
dep = subprocess.run(
    ['curl', '-s', '-X', 'POST', f'http://localhost:4000/api/intelledger/sessions/{sid}/actions/{aids[1]}/dependencies',
     '-H', 'Content-Type: application/json',
     '-d', f'{{"depends_on":["{aids[0]}"]}}'],
    capture_output=True, text=True
)
result = json.loads(dep.stdout)['action']
print("Dependencies:", result['depends_on'])
print("Blocked:", result['blocked_by_dependencies'])
```

**Expected Output:**
```
Tags: ['urgent', 'code-review']
Dependencies: ['<action-id-1>']
Blocked: True
```

---

## Architecture Notes

### Source ↔ Runtime Separation
- **Why:** Keeps source repo lightweight (55MB vs 1.1GB with node_modules)
- **How:** Git worktree pattern — separate working directories from same git repo
- **Workflow:** Edit in source, rsync to runtime, test from runtime
- **Don't:** Run npm install in source folder (it will grow to 1GB)

### Data Persistence
- All sessions, actions, signals stored in `/Users/mnayman/Downloads/mirabilis-data/`
- Resolved via `backend/src/config.js` from `MIRABILIS_DATA_DIR` env var
- Survives server restarts and code resyncs

### Intelledger Signal Extraction
- Text ingestion → Natural language extraction (dates, priorities, urgencies)
- Signals stored in action metadata: `source_signal_type`, `urgency_score`, `due_date`
- Features (tags, dependencies) are orthogonal — layer on top of signal data

---

## Known Issues & Workarounds

| Issue | Workaround |
|-------|-----------|
| Source folder grows after npm install | Use mirabilis-runtime for testing |
| Changes not appearing after restart | Did you rsync? Check `rsync ... --delete` removes old files |
| Backend port 4000 already in use | `pkill -f "node backend"` then restart |
| Circular dep detection false positive | Check dependency chain doesn't form loop A→B→C→A |

---

## Next Steps / TODO

### UI Integration (Frontend)
- [ ] Add tag input field to action editor
- [ ] Display tags as pills with remove buttons
- [ ] Add tag filter sidebar
- [ ] Show dependency graph visualization
- [ ] Blocking status indicator on action cards

### Backend Enhancements
- [ ] Bulk tag operations (tag multiple actions at once)
- [ ] Dependency templating (common patterns)
- [ ] Export sessions with tags/deps as JSON
- [ ] Webhook on dependency completion

### Testing & Validation
- [ ] Integration tests for circular dependency detection
- [ ] Stress test with large dependency graphs (100+ nodes)
- [ ] Tag performance with high cardinality (1000+ unique tags)

---

## Reference

### Config Locations
- Backend: `backend/src/config.js`
- Frontend: `frontend/next.config.js`, `tailwind.config.js`
- Data path: Resolved from `MIRABILIS_DATA_DIR` env var, defaults to `/Downloads/mirabilis-data`

### Key Files
- `backend/src/routes/intelLedger.js` — All API routes
- `backend/src/storage/intelLedger.js` — Data persistence + helpers
- `backend/src/server.js` — Express app initialization

### API Base
- Port: `4000`
- Health: `GET /api/intelledger/sessions?userId={id}` (returns 200 if up)

---

**Questions?** Check terminal history: `echo "Git log:" && cd /Users/mnayman/Downloads/mirabilis && git log --oneline | head -20`
