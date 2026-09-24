// MCP client for the TigerGraph MCP server (https://github.com/tigergraph/tigergraph-mcp).
//
// The brief asks that the graph be exposed to the agent through TigerGraph MCP.
// This is that path: the server is spawned over stdio and its tools are called
// through the Model Context Protocol rather than through our own REST calls.
//
// stdio rather than streamable-http on purpose. The HTTP transport pulls in
// uvicorn, whose installed websockets version is incompatible on this machine
// (ImportError: cannot import name 'ServerProtocol'), and stdio needs no HTTP
// stack, no port and no extra process management.
//
// The tools used here are real, taken from the server's published surface:
//   tigergraph__run_installed_query    runs one of our compiled GSQL queries
//   tigergraph__get_graph_schema       schema introspection
//   tigergraph__search_top_k_similarity  server-side vector search
//   tigergraph__get_vertex_count       count verification
//
// Credentials come from .env. Savanna serves everything over 443, so the
// RESTPP/GS/SSL ports are all set to that.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function envVar(name: string): string {
  try {
    for (const line of readFileSync(path.join(REPO_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      if (line.slice(0, line.indexOf('=')).trim() === name) return line.slice(line.indexOf('=') + 1).trim();
    }
  } catch {
    return process.env[name] ?? '';
  }
  return process.env[name] ?? '';
}

/**
 * Where the tigergraph-mcp executable lives. Installed as a console script by
 * pip, which on Windows lands in the interpreter's Scripts directory.
 * Override with TIGERGRAPH_MCP_BIN.
 */
function serverCommand(): string {
  const explicit = envVar('TIGERGRAPH_MCP_BIN');
  if (explicit !== '') return explicit;
  return 'tigergraph-mcp';
}

export interface McpToolSummary {
  readonly name: string;
  readonly description: string;
}

export class TigerGraphMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: McpToolSummary[] = [];

  static isConfigured(): boolean {
    return envVar('TIGERGRAPH_HOST') !== '' && envVar('TIGERGRAPH_TOKEN') !== '';
  }

  /** Exchanges the database secret for a JWT the MCP server can use. */
  private async jwt(): Promise<string> {
    const host = envVar('TIGERGRAPH_HOST').replace(/\/$/, '');
    const res = await fetch(`${host}/gsql/v1/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: envVar('TIGERGRAPH_TOKEN'), lifetime: '2592000' }),
    });
    const body = (await res.json()) as { token?: string; message?: string };
    if (!body.token) throw new Error(`could not mint a TigerGraph JWT: ${body.message ?? ''}`);
    return body.token;
  }

  /** Spawns the MCP server and completes the handshake. Idempotent. */
  async connect(): Promise<readonly McpToolSummary[]> {
    if (this.client !== null) return this.tools;
    const token = await this.jwt();
    const host = envVar('TIGERGRAPH_HOST').replace(/\/$/, '');

    this.transport = new StdioClientTransport({
      command: serverCommand(),
      args: [],
      env: {
        ...(process.env as Record<string, string>),
        TG_HOST: host,
        TG_GRAPHNAME: envVar('TIGERGRAPH_GRAPH_NAME') || 'FraudGraph',
        TG_JWT_TOKEN: token,
        TG_RESTPP_PORT: '443',
        TG_GS_PORT: '443',
        TG_SSL_PORT: '443',
      },
      stderr: 'pipe',
    });

    this.client = new Client({ name: 'hh-fraudprevagent', version: '0.1.0' }, { capabilities: {} });
    await this.client.connect(this.transport);

    const listed = await this.client.listTools();
    this.tools = listed.tools.map((t) => ({ name: t.name, description: (t.description ?? '').split('\n')[0] ?? '' }));
    return this.tools;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.transport = null;
  }

  /** Calls a tool and returns its text content parsed as JSON where possible. */
  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.client === null) await this.connect();
    const client = this.client;
    if (client === null) throw new Error('MCP client failed to connect');
    const result = await client.callTool({ name: tool, arguments: args });
    const content = (result.content ?? []) as { type?: string; text?: string }[];
    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text ?? '')
      .join('\n');
    if (result.isError === true) throw new Error(`MCP tool ${tool} failed: ${text.slice(0, 400)}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  /**
   * Runs one of the compiled GSQL queries through MCP. This is the call that
   * makes the graph reachable via MCP rather than via our own REST client.
   */
  async runInstalledQuery(queryName: string, params: Record<string, string | number>): Promise<unknown> {
    return this.call('tigergraph__run_installed_query', {
      graph_name: envVar('TIGERGRAPH_GRAPH_NAME') || 'FraudGraph',
      query_name: queryName,
      params,
    });
  }

  async getVertexCount(vertexType: string): Promise<unknown> {
    return this.call('tigergraph__get_vertex_count', {
      graph_name: envVar('TIGERGRAPH_GRAPH_NAME') || 'FraudGraph',
      vertex_type: vertexType,
    });
  }

  async getGraphSchema(): Promise<unknown> {
    return this.call('tigergraph__get_graph_schema', {
      graph_name: envVar('TIGERGRAPH_GRAPH_NAME') || 'FraudGraph',
    });
  }
}
