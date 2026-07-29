// Minimal stdio MCP server for testing spawnSession's extraMcpServers wiring.
// Newline-delimited JSON-RPC 2.0 (the MCP stdio transport). Exposes ONE tool,
// `ping`, that returns a fixed verification token so the harness can prove the
// tool actually executed (i.e. approval round-trip + engine tool-call worked).
const TOKEN = process.env.MOCK_TOKEN || 'MOCK-OK-7F3A9';
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) handle(l); } });
function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function handle(line) {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '0.0.1' } } });
  } else if (m.method === 'notifications/initialized') {
    // notification — no response
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'Returns a fixed verification token. Takes no arguments.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } });
  } else if (m.method === 'tools/call') {
    if (m.params?.name === 'ping') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: TOKEN }] } });
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such tool' } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, result: {} }); // answer any other request so the client never hangs
  }
}
