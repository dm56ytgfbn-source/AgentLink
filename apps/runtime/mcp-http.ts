import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ComputerContext } from './context.js';
import { createAgentLinkServer } from './mcp-server.js';
import { resolvePaths, registryForRead, type Paths } from '../../packages/config/index.js';

// Local HTTP entry point (Streamable HTTP). Loopback-only by default, bearer token, no
// ambient authority: an agent on this machine or on the LAN can use the same tools.
const MAX_BODY = 4 * 1024 * 1024;

export interface HttpOptions { port?:number; host?:string; token?:string; session?:string }

function parseArgs(argv:string[]):HttpOptions {
  const options:HttpOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--port') options.port = Number(argv[++index]);
    else if (flag === '--host') options.host = argv[++index];
    else if (flag === '--session') options.session = argv[++index];
    else if (flag === '--help') { options.port = -1; }
  }
  return options;
}

function secretEqual(a:string, b:string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function loadHttpToken(paths:Paths, override?:string):Promise<{token:string; created:boolean; file:string}> {
  if (override) return { token: override, created: false, file: paths.httpToken };
  try {
    const value = JSON.parse(await readFile(paths.httpToken, 'utf8')) as { token?:string };
    if (typeof value.token === 'string' && value.token.length >= 32) return { token: value.token, created: false, file: paths.httpToken };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('hex');
  await mkdir(path.dirname(paths.httpToken), { recursive: true, mode: 0o700 });
  await writeFile(paths.httpToken, JSON.stringify({ token, created_at: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { token, created: true, file: paths.httpToken };
}

function readBody(request:http.IncomingMessage):Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks:Buffer[] = []; let size = 0;
    request.on('data', (chunk:Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('Request body too large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve(undefined); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
    });
  });
}

export async function startHttpServer(options:HttpOptions = {}, paths = resolvePaths()) {
  const configPath = registryForRead(paths);
  const session = options.session ?? process.env.AGENTLINK_SESSION ?? 'default';
  const host = options.host ?? '127.0.0.1';
  const port = Number.isInteger(options.port) && (options.port as number) > 0 ? options.port as number : 7788;
  const { token, created, file } = await loadHttpToken(paths, options.token);

  const server = http.createServer(async (request, response) => {
    const send = (status:number, value:unknown) => {
      if (response.destroyed) return;
      const body = JSON.stringify(value);
      response.writeHead(status, { 'content-type':'application/json', 'content-length':Buffer.byteLength(body), 'cache-control':'no-store' });
      response.end(body);
    };
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/health') {
      send(200, { ok:true, service:'agentlink-mcp-http', version:'0.2.0', session, computers: (await new ComputerContext(configPath, session).devices().catch(() => [])).map(d => d.name) });
      return;
    }
    if (url.pathname !== '/mcp') { send(404, { ok:false, error:'NOT_FOUND' }); return; }
    if (!secretEqual(String(request.headers.authorization ?? ''), 'Bearer ' + token)) {
      response.writeHead(401, { 'content-type':'application/json', 'www-authenticate':'Bearer realm="AgentLink"' });
      response.end(JSON.stringify({ ok:false, error:'UNAUTHORIZED' }));
      return;
    }
    let body:unknown;
    try { body = await readBody(request); } catch (error) {
      send(400, { jsonrpc:'2.0', error:{ code:-32700, message:(error as Error).message }, id:null });
      return;
    }
    // Stateless mode: one server + transport per request. No session state is retained.
    const mcp = createAgentLinkServer(new ComputerContext(configPath, session));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { void transport.close(); void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) send(500, { jsonrpc:'2.0', error:{ code:-32603, message:(error as Error).message }, id:null });
      else response.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { server, port, host, token, tokenCreated:created, tokenFile:file, configPath, session };
}

if (process.argv[1] && process.argv[1].endsWith('mcp-http.js')) {
  const options = parseArgs(process.argv.slice(2));
  if (options.port === -1) {
    console.log('agentlink mcp --http [--port 7788] [--host 127.0.0.1] [--session NAME]');
    process.exit(0);
  }
  const started = await startHttpServer(options);
  console.log('AgentLink MCP over HTTP: http://' + started.host + ':' + started.port + '/mcp');
  console.log('Session: ' + started.session + '  Config: ' + started.configPath);
  console.log('Token file: ' + started.tokenFile + (started.tokenCreated ? ' (newly created, mode 0600)' : ' (existing)'));
  if (started.host !== '127.0.0.1' && started.host !== '::1') console.log('WARNING: bound to ' + started.host + '; any host that can reach this port and read the token file may use these tools.');
  const stop = () => { started.server.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
