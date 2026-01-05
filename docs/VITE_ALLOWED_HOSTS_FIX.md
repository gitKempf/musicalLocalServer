# Vite allowedHosts Fix for Tunnel-Based Preview

> ⚠️ **Note**: This is a fallback fix. The proper architectural solution is the 
> **Preview Verification System** that detects errors and triggers Claude to fix them.
> See `PREVIEW_VERIFICATION_ARCHITECTURE.md` for the full solution.

## Problem

When accessing previews through the Cloudflare tunnel chain:
```
Frontend → Tunnel Router → Cloudflare Tunnel → Local Server → Preview Proxy → Container (Vite)
```

Vite 5+ was blocking requests with the error:
```
Blocked request. This host ("preview-project_xxx") is not allowed.
To allow this host, add "preview-project_xxx" to `server.allowedHosts` in vite.config.js.
```

## Root Cause Analysis

1. **Vite 5.0+ introduced strict `allowedHosts` security** (October 2023)
2. By default, Vite only allows `localhost`, `.localhost` domains, and IP addresses
3. When requests come through the tunnel/proxy chain, the `Host` header may not match what Vite expects
4. Even though the preview proxy sets `host: localhost:3000`, Vite's security check was detecting the container name

## The Fix

Two-pronged approach implemented in `PreviewBuildService.ts`:

### 1. Vite Configuration Patching

Before starting the dev server, we detect if the project uses Vite and patch the config to add:
```javascript
server: {
  allowedHosts: true,  // Allow all hosts through proxy
  host: '0.0.0.0',     // Listen on all interfaces
}
```

This handles:
- Projects with existing `vite.config.js/ts`
- Projects with Vite as a dependency but no config file
- Various config file extensions (`.js`, `.ts`, `.mjs`, `.mts`)

### 2. Environment Variable Fallback

When starting the dev server, we set:
```bash
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=true npm run dev
```

This is an internal Vite environment variable that adds additional allowed hosts without requiring config changes.

## Why `allowedHosts: true` is Safe Here

Setting `allowedHosts: true` is normally dangerous because it allows DNS rebinding attacks. However, in our case:

1. **The dev server is inside an isolated Docker container** - It can't access the host system's files
2. **The container is only accessible through our proxy chain** - Not directly from the internet
3. **The preview is already public via the tunnel** - The security boundary is at the authentication layer, not the Vite server
4. **This is a development preview, not production** - Source code exposure is expected for preview functionality

## Files Changed

- `/root/local-server/src/services/PreviewBuildService.ts`:
  - Added `configureViteAllowedHosts()` method to patch Vite configuration
  - Updated `startPreviewServer()` to call the new method
  - Added `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` env var when starting npm scripts

## Testing

To verify the fix works:

1. Create a new Vite project in Musical.run
2. The preview should load without the "Host not allowed" error
3. Check container logs to see "Patched Vite config with allowedHosts: true"

## Related Links

- [Vite server.allowedHosts documentation](https://vitejs.dev/config/server-options.html#server-allowedhosts)
- [Vite security advisory GHSA-vg6x-rcgg-rjx6](https://github.com/vitejs/vite/security/advisories/GHSA-vg6x-rcgg-rjx6)
