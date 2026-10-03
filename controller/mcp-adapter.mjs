import {McpServer, fromJsonSchema} from '@modelcontextprotocol/server';
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {browserTools} from './core.mjs';
import {installRelayToolMetadata, relayBrowserToolDescriptors} from './mcp-tool-metadata.mjs';

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
    {maxToolInputElements: target === 'relay' ? 128 : 32}
  );

  for (const tool of target === 'relay' ? relayBrowserToolDescriptors : browserTools) {
    const annotations = {
      ...structuredClone(tool.annotations || {}),
      openWorldHint: target === 'relay',
      ...(['browser_click', 'browser_fill'].includes(tool.name)
        ? {readOnlyHint: false, destructiveHint: true, idempotentHint: false}
        : {})
    };
    server.registerTool(tool.name, {
      description: target === 'fixture' ? `${tool.description} This connection serves only the local test fixture.` :
        tool.description,
      annotations,
      inputSchema: fromJsonSchema(structuredClone(tool.inputSchema)),
      ...(tool.outputSchema ? {outputSchema: fromJsonSchema(structuredClone(tool.outputSchema))} : {}),
      ...(target === 'relay' ? {_meta: structuredClone(tool._meta)} : {})
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
  if (target === 'relay') installRelayToolMetadata(server, relayBrowserToolDescriptors);
  return server;
}

/** Explicit opt-in for a host that already bound a trusted workspace context. */
export async function connectControllerStdio(options) {
  const server = createControllerMcp(options);
  await server.connect(new StdioServerTransport());
  return server;
}
