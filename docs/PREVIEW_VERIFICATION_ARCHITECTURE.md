# Preview Verification Architecture

## Overview

The Preview Verification System ensures that generated projects actually work by:
1. **Detecting project types** - React Native Web, Vite, Next.js, Vue, etc.
2. **Validating preview health** - HTTP health checks after each Claude commit
3. **Diagnosing errors** - Pattern matching against known error types
4. **Triggering auto-fixes** - Sending actionable prompts to Claude to fix issues

## The Problem

When Claude generates code, there's no guarantee the code will actually run correctly.
Common issues include:
- Missing configuration (like Vite's `allowedHosts`)
- Missing dependencies
- Syntax errors
- Import path issues
- Framework-specific configuration problems

Previously, users would see cryptic error pages and have to manually ask Claude to fix things.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Claude Code Agent                             │
│                                                                      │
│  ┌──────────────┐    ┌────────────────┐    ┌───────────────────┐   │
│  │ User Prompt  │───▶│ Claude Coding  │───▶│ commit-on-stop.sh │   │
│  └──────────────┘    └────────────────┘    └─────────┬─────────┘   │
│                                                       │              │
│                                         ┌─────────────▼──────────┐  │
│                                         │ verify-preview.sh      │  │
│                                         └─────────────┬──────────┘  │
└───────────────────────────────────────────────────────┼─────────────┘
                                                        │
                                           API Call     ▼
┌───────────────────────────────────────────────────────────────────────┐
│                         Local Server                                   │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                  Preview Verification Service                    │  │
│  │                                                                  │  │
│  │  1. Detect Project Type (vite, nextjs, react-native-web, etc.) │  │
│  │  2. Health Check Preview URL                                    │  │
│  │  3. Pattern Match Error (syntax, module, config issues)        │  │
│  │  4. Generate Claude Prompt for Fix                              │  │
│  │  5. Record Health History                                       │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                      Preview Build Service                       │  │
│  │  (Applies fallback fixes like Vite allowedHosts patching)       │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
                                    │
                    Auto-Fix Prompt │ (if error detected)
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│                        Claude Code Agent                               │
│                                                                        │
│  Receives prompt like:                                                │
│  "The preview is failing because Vite is blocking external hosts.    │
│   Please update vite.config.js to add server.allowedHosts: true"     │
│                                                                        │
│  Claude makes the fix ──▶ commit-on-stop.sh ──▶ verify again         │
└───────────────────────────────────────────────────────────────────────┘
```

## Project Types

| Type | Detection | Common Errors |
|------|-----------|---------------|
| `vite` | `vite` in package.json | allowedHosts, module resolution |
| `react-native-web` | `expo` or `react-native-web` in deps | Metro bundler, Expo config |
| `nextjs` | `next` in package.json | Server components, API routes |
| `create-react-app` | `react-scripts` in deps | Build failures, env vars |
| `vue` | `vue` or `@vue/cli-service` in deps | Component errors, build |
| `static` | No package.json | Missing files |

## Error Patterns

The system matches response bodies against known patterns:

### Vite Errors
```javascript
{
  pattern: /Blocked request.*allowedHosts/i,
  errorType: 'vite_allowed_hosts',
  claudePrompt: 'Update vite.config.js to add server.allowedHosts: true'
}
```

### Common Errors
```javascript
{
  pattern: /SyntaxError|Parsing error/i,
  errorType: 'syntax_error',
  claudePrompt: 'Fix the syntax error at the indicated line'
}
```

## Database Schema

```sql
-- Project type tracking
ALTER TABLE projects ADD COLUMN project_type VARCHAR(50) DEFAULT 'unknown';
ALTER TABLE projects ADD COLUMN preview_status VARCHAR(50) DEFAULT 'pending';
ALTER TABLE projects ADD COLUMN preview_last_error TEXT;
ALTER TABLE projects ADD COLUMN auto_fix_attempts INTEGER DEFAULT 0;

-- Health check history
CREATE TABLE preview_health_checks (
  id UUID PRIMARY KEY,
  project_id VARCHAR(255),
  check_type VARCHAR(50),  -- 'http', 'build', 'startup'
  status VARCHAR(50),      -- 'success', 'error', 'timeout'
  error_type VARCHAR(100), -- 'vite_allowed_hosts', 'module_not_found', etc.
  error_message TEXT,
  created_at TIMESTAMP
);
```

## API Endpoints

### POST /api/preview/verify
Verifies preview health and returns whether auto-fix should be attempted.

**Request:**
```json
{
  "projectId": "project_xxx",
  "sessionId": "session_xxx"
}
```

**Response:**
```json
{
  "status": "error",
  "projectType": "vite",
  "error": {
    "type": "vite_allowed_hosts",
    "message": "Vite is blocking requests from external hosts",
    "suggestion": "Add server.allowedHosts: true to vite.config.js"
  },
  "shouldAutoFix": true,
  "claudePrompt": "The preview is failing because..."
}
```

### POST /api/preview/detect-type
Detects project type from package.json.

### GET /api/preview/health-history/:projectId
Returns health check history for debugging.

## Auto-Fix Flow

1. **Claude completes task** → `commit-on-stop.sh` commits changes
2. **Push to Gitea** → Webhook triggers preview rebuild
3. **Wait for build** → `verify-preview.sh` waits 5 seconds
4. **Health check** → API checks preview URL
5. **Error detected** → Pattern matched, Claude prompt generated
6. **Auto-fix decision** → Check attempt count (max 3)
7. **Send to Claude** → Structured prompt output for session manager
8. **Claude fixes** → Loop back to step 1

## Rate Limiting

- Maximum 3 auto-fix attempts per error
- Minimum 30 seconds between attempts
- Auto-fix attempts reset when preview becomes healthy

## Files

| File | Purpose |
|------|---------|
| `src/services/PreviewVerificationService.ts` | Core verification logic |
| `src/routes/previewVerification.ts` | API endpoints |
| `claude-agent/hooks/verify-preview.sh` | Hook called after commit |
| `claude-agent/hooks/commit-on-stop.sh` | Updated to call verify hook |
| `scripts/migrations/002_add_preview_verification.sql` | Database migration |

## Fallback Mechanisms

Even with the verification system, we maintain fallback fixes in `PreviewBuildService.ts`:
- **Vite allowedHosts patching** - Automatically patches vite.config.js
- **Environment variable injection** - Sets `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`

These fallbacks prevent common errors before they happen, while the verification
system handles errors that slip through.

## Future Improvements

1. **Build log analysis** - Parse build output for earlier error detection
2. **Container log streaming** - Real-time error detection
3. **Test execution** - Run tests after code changes
4. **Visual regression** - Screenshot comparison for UI changes
5. **Performance monitoring** - Track response times over time
