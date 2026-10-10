/**
 * Minimal stdio MCP server backing the `/api/mcp*` route tests.
 *
 * Speaks newline-delimited JSON-RPC over stdin/stdout: answers `initialize`,
 * `tools/list` (one `echo` tool), `tools/call` and `ping`, silently ignores
 * notifications, and exits when stdin closes (i.e. when the client transport
 * tears the child down). No network, no dependencies.
 */

let buffer = '';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleMessage(message) {
  // A notification carries no id and must not be answered.
  if (!message || typeof message !== 'object' || message.id === undefined || message.id === null) {
    return;
  }

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp-server', version: '0.0.1' }
      }
    });
    return;
  }

  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo the provided text back.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } }
            }
          }
        ]
      }
    });
    return;
  }

  if (message.method === 'tools/call') {
    const text = message.params?.arguments?.text ?? '';
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: String(text) }] }
    });
    return;
  }

  if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: `Method not found: ${message.method}` }
  });
}

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handleMessage(JSON.parse(line));
      } catch {
        // A malformed line is ignored: the tests only drive well-formed traffic.
      }
    }
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
