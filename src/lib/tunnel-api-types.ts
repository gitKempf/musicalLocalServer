/**
 * Tunnel API Types and Interfaces
 * 
 * Clean interface definitions for the tunnel router API.
 * Used by both the tunnel-router service and local servers.
 */

// ============================================================================
// Server Registration
// ============================================================================

/**
 * Request to register a local server with the tunnel router
 */
export interface TunnelRegisterRequest {
  /** User ID from authentication */
  userId: string;
  
  /** Unique identifier for this server instance */
  serverId: string;
  
  /** Human-readable server name */
  serverName: string;
  
  /** Direct tunnel URL (e.g., ngrok, cloudflared, or direct IP) */
  tunnelUrl: string;
  
  /** Public key for end-to-end encryption */
  encryptionPubkey: string;
  
  /** Server type: 'local' | 'cloud' | 'enterprise' */
  serverType?: 'local' | 'cloud' | 'enterprise';
  
  /** Server version */
  version?: string;
  
  /** Server capabilities */
  capabilities?: string[];
}

export interface TunnelRegisterResponse {
  success: boolean;
  serverId: string;
  message?: string;
  error?: string;
}

// ============================================================================
// Server Status
// ============================================================================

/**
 * Status information for a single server
 */
export interface ServerStatus {
  /** Server identifier */
  serverId: string;
  
  /** Human-readable name */
  serverName: string;
  
  /** Whether the server is currently reachable */
  connected: boolean;
  
  /** Server type */
  serverType: 'local' | 'cloud' | 'enterprise';
  
  /** Tunnel URL */
  tunnelUrl: string;
  
  /** Public key for encryption */
  serverPublicKey: string;
  
  /** Last heartbeat timestamp */
  lastSeen: string;
  
  /** Seconds since last heartbeat */
  lastSeenAgo: number;
  
  /** When the server was first registered */
  createdAt: string;
}

export interface TunnelStatusResponse {
  success: boolean;
  
  /** For single server query */
  connected?: boolean;
  serverId?: string;
  serverName?: string;
  serverType?: string;
  tunnelUrl?: string;
  serverPublicKey?: string;
  lastSeen?: string;
  lastSeenAgo?: number;
  createdAt?: string;
  
  /** For multi-server query */
  servers?: ServerStatus[];
  totalServers?: number;
  activeServers?: number;
  
  message?: string;
  error?: string;
}

// ============================================================================
// Proxy Requests
// ============================================================================

/**
 * Request to proxy an HTTP call through the tunnel
 */
export interface TunnelProxyRequest {
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  
  /** Path on the local server (e.g., /api/projects) */
  path: string;
  
  /** Headers to forward */
  headers?: Record<string, string>;
  
  /** Request body for POST/PUT/PATCH */
  body?: any;
  
  /** Optional server ID (can also be in URL) */
  serverId?: string;
}

export interface TunnelProxyResponse {
  success: boolean;
  
  /** Forwarded response data */
  data?: any;
  
  /** Response status code */
  status?: number;
  
  error?: string;
  details?: string;
  hint?: string;
}

// ============================================================================
// Encrypted Messages
// ============================================================================

/**
 * Request to route an encrypted message
 */
export interface TunnelMessageRequest {
  /** Target user ID */
  userId: string;
  
  /** Encrypted message blob */
  encryptedMessage: string;
  
  /** Session ID for context */
  sessionId: string;
  
  /** Sender's public key for response encryption */
  senderPublicKey: string;
}

export interface TunnelMessageResponse {
  success: boolean;
  
  /** Encrypted response from local server */
  encryptedResponse?: string;
  
  /** Timestamp */
  timestamp?: string;
  
  error?: string;
  details?: string;
  hint?: string;
}

// ============================================================================
// Heartbeat
// ============================================================================

export interface TunnelHeartbeatRequest {
  userId: string;
  serverId: string;
}

export interface TunnelHeartbeatResponse {
  success: boolean;
  timestamp: string;
  error?: string;
}

// ============================================================================
// API Client Interface
// ============================================================================

/**
 * Interface for interacting with the tunnel router
 */
export interface ITunnelClient {
  /**
   * Register this server with the tunnel router
   */
  register(request: TunnelRegisterRequest): Promise<TunnelRegisterResponse>;
  
  /**
   * Unregister this server
   */
  unregister(userId: string, serverId: string): Promise<{ success: boolean }>;
  
  /**
   * Send heartbeat to maintain connection
   */
  heartbeat(userId: string, serverId: string): Promise<TunnelHeartbeatResponse>;
  
  /**
   * Get status of a specific server
   */
  getServerStatus(userId: string, serverId: string): Promise<TunnelStatusResponse>;
  
  /**
   * Get all servers for a user
   */
  getAllServers(userId: string): Promise<TunnelStatusResponse>;
}

// ============================================================================
// Error Codes
// ============================================================================

export const TunnelErrorCodes = {
  SERVER_NOT_FOUND: 'SERVER_NOT_FOUND',
  SERVER_UNREACHABLE: 'SERVER_UNREACHABLE',
  INVALID_REQUEST: 'INVALID_REQUEST',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  TIMEOUT: 'TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
} as const;

export type TunnelErrorCode = typeof TunnelErrorCodes[keyof typeof TunnelErrorCodes];

export interface TunnelError {
  code: TunnelErrorCode;
  message: string;
  details?: string;
  hint?: string;
}
