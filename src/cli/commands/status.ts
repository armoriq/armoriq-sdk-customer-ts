/**
 * armoriq status / logs — local-only commands that read the cached state
 * and CLI log file. Mirrors armoriq_sdk/cli.py:cmd_status / cmd_logs.
 */

import * as fs from 'fs';
import { out } from '../util';
import { LOG_FILE, loadState } from '../state';

export function cmdStatus(): number {
  const state = loadState();
  if (!state || Object.keys(state).length === 0) {
    out('No local registration state found. Run `armoriq register` first.');
    return 1;
  }
  out(`Agent: ${state.agent_id ?? 'unknown'}`);
  out(`User: ${state.user_id ?? 'unknown'}`);
  out(`Environment: ${state.environment ?? 'unknown'}`);
  out(`Registered at: ${state.registered_at ?? 'unknown'}`);
  out(`Proxy endpoint: ${state.proxy_endpoint ?? 'unknown'}`);
  const mcpServers = state.mcp_servers ?? [];
  out(`MCP servers: ${mcpServers.length > 0 ? mcpServers.join(', ') : '(none)'}`);
  return 0;
}

export function cmdLogs(args: { follow?: boolean }): number {
  if (!fs.existsSync(LOG_FILE)) {
    out('No CLI logs found yet.');
    return 0;
  }
  const tailFile = (offset: number): number => {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size <= offset) return offset;
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    for (const line of buf.toString('utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        out(`[${event.timestamp ?? ''}] ${event.event ?? ''}: ${JSON.stringify(event.details ?? {})}`);
      } catch {
        out(trimmed);
      }
    }
    return stat.size;
  };
  let offset = tailFile(0);
  if (!args.follow) return 0;
  // Simple poll loop for --follow; ctrl-C exits.
  const interval = setInterval(() => {
    offset = tailFile(offset);
  }, 1000);
  // Return a never-resolving promise via process exit hook isn't useful here;
  // the user expects --follow to block. Keep the process alive until SIGINT.
  process.on('SIGINT', () => {
    clearInterval(interval);
    process.exit(0);
  });
  // Block forever — this function is the entrypoint of the command.
  return 0;
}
