import {McpServer, fromJsonSchema} from '@modelcontextprotocol/server';
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {browserTools} from './core.mjs';

const relayDescriptions = {
  browser_open: 'Open this host-approved Relay worker workspace. It permits only navigation, refresh and masked screenshots; websites, identity and profiles are configured by the trusted host.',
  browser_observe: 'Observe this worker’s allowed Relay navigation and Refresh controls. Returns bounded opaque targets, excluding private messages and credential fields.',
  browser_click: 'Click one advertised Relay navigation or Refresh control using the current observation. Returns a fresh observation. Never retry an uncertain click automatically.',
  browser_screenshot: 'Capture this worker’s masked Relay workspace using a current observation. Private content and credential fields are hidden.',
  browser_close: 'Close this worker’s host-approved Relay browser session.'
};

/**
 * MCP seam. requestContext and target are configured by the trusted local host,
 * never supplied in a tool's arguments. The controller remains responsible for
 * fresh authorization and queue ownership before every browser operation.
 * This factory neither listens on a network endpoint nor grants authorization.
 */
export function createControllerMcp({controller, requestContext, target = 'fixture'} = {}) {
  if (!controller || typeof controller.callTool !== 'function' ||
      !requestContext || typeof requestContext !== 'object' || Array.isArray(requestContext) ||
      !['fixture', 'relay'].includes(target)) {
    throw new TypeError('A controller and trusted request context are required.');
  }

  const server = new McpServer(
    {name: target === 'fixture' ? 'relay-browser-fixture' : 'relay-browser-controller', version: '0.1.0'},
    {maxToolInputElements: 32}
  );

  for (const tool of browserTools) {
    if (target === 'relay' && tool.name === 'browser_fill') continue;
    const annotations = {
      ...structuredClone(tool.annotations || {}),
      openWorldHint: target === 'relay',
      ...(['browser_click', 'browser_fill'].includes(tool.name)
        ? {readOnlyHint: false, destructiveHint: true, idempotentHint: false}
        : {})
    };
    server.registerTool(tool.name, {
      description: target === 'fixture' ? `${tool.description} This connection serves only the local test fixture.` :
        relayDescriptions[tool.name],
      annotations,
      inputSchema: fromJsonSchema(structuredClone(tool.inputSchema)),
      ...(tool.outputSchema ? {outputSchema: fromJsonSchema(structuredClone(tool.outputSchema))} : {})
    }, async args => {
      try {
        return await controller.callTool({name: tool.name, arguments: args}, requestContext);
      } catch {
        // The SDK otherwise exposes a thrown exception's message to the model.
        // Driver/resolver faults may mention private profile paths or secrets.
        const message = 'The browser controller could not complete this request.';
        return {
          isError: true,
          structuredContent: {error: {code: 'INTERNAL', message}},
          content: [{type: 'text', text: message}]
        };
      }
    });
  }
  return server;
}

/** Explicit opt-in for a host that already bound a trusted workspace context. */
export async function connectControllerStdio(options) {
  const server = createControllerMcp(options);
  await server.connect(new StdioServerTransport());
  return server;
}
