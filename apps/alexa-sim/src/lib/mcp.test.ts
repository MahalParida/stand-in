// @vitest-environment happy-dom
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { isSessionLost } from './mcp.js';

describe('isSessionLost (reconnect trigger)', () => {
  it('matches the SDK errors for a session the server dropped (idle sweep / restart)', () => {
    expect(isSessionLost(new StreamableHTTPError(404, 'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}'))).toBe(true);
    expect(isSessionLost(new Error('Streamable HTTP error: Error POSTing to endpoint: {"code":-32001,"message":"Session not found"}'))).toBe(true);
  });
  it('does not treat other failures as a lost session', () => {
    expect(isSessionLost(new StreamableHTTPError(401, 'Unauthorized'))).toBe(false);
    expect(isSessionLost(new Error('MCP error -32602: invalid arguments'))).toBe(false);
    expect(isSessionLost(undefined)).toBe(false);
  });
});
