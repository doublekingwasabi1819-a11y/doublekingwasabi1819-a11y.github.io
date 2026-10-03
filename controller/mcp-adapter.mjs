import {McpServer, fromJsonSchema} from '@modelcontextprotocol/server';
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {browserTools} from './core.mjs';

/**
 * Fixture-only MCP seam. requestContext is configured by the trusted local host,
 * never supplied in a tool's arguments. The controller remains responsible for
 * fresh authorization and queue ownership before every browser operation.
 * This factory neither listens on a network endpoint nor grants authorization.
 */
export function createControllerMcp({controller, requestContext} = {}) {
  if (!controller || typeof controller.callTool !== 'function' ||
      !requestContext || typeof requestContext !== 'object' || Array.isArray(requestContext)) {
    throw new TypeError('A controller and trusted request context are required.');
  }

  const server = new McpServer(
    {name: 'relay-browser-fixture', version: '0.1.0'},
    {maxToolInputElements: 32}
  );

  for (const tool of browserTools) {
    const annotations = {
      ...structuredClone(tool.annotations || {}),
      openWorldHint: false,
      ...(['browser_click', 'browser_fill'].includes(tool.name)
        ? {readOnlyHint: false, destructiveHint: true, idempotentHint: false}
        : {})
    };
    server.registerTool(tool.name, {
      description: tool.description,
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

/** Explicit opt-in for a host that already bound a trusted fixture context. */
export async function connectControllerStdio(options) {
  const server = createControllerMcp(options);
  await server.connect(new StdioServerTransport());
  return server;
}
