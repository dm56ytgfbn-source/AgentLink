import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { call, type Device } from './client.js';
import { ComputerContext } from './context.js';
import { inspectDevice } from './health.js';
import { findNativeApp } from './app-find.js';

// Agent-neutral MCP surface. Every transport (stdio, HTTP) and every agent shares this
// one factory, so tool names and behaviour cannot drift between entry points.
async function resolveDevice(context: ComputerContext, computer?: string): Promise<Device> {
  const devices = await context.devices();
  if (computer) {
    const matches = devices.filter(d => d.name === computer || d.device_id === computer);
    if (matches.length !== 1) throw new Error('Unknown or ambiguous computer: ' + computer);
    return matches[0];
  }
  const current = await context.current();
  if (current.local) throw new Error('Current context is the local machine. Call computer_use first, or pass computer="<name>".');
  const device = devices.find(d => d.device_id === current.computer_id);
  if (!device) throw new Error('Selected computer is no longer paired');
  return device;
}

async function workingDirectory(context: ComputerContext, device: Device, requested?: string): Promise<string> {
  if (requested) return requested;
  const current = await context.current();
  if (!current.local && current.computer_id === device.device_id && current.cwd) return current.cwd;
  const info = await call(device) as { default_cwd?: string };
  if (info.default_cwd) return info.default_cwd;
  throw new Error('This computer has not advertised a working directory. Select it with computer_use(cwd), or pass cwd once.');
}

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

export function createAgentLinkServer(context: ComputerContext, options: { version?: string } = {}) {
  const server = new McpServer({ name: 'agentlink', version: options.version ?? '0.2.0' });

  async function taskDevice(computer: string) {
    const device = await resolveDevice(context, computer);
    const info = await call(device) as { capabilities?: string[] };
    if (!info.capabilities?.includes('tasks')) throw new Error('The selected computer has not enabled durable tasks; upgrade/configure it before submitting. Do not substitute a synchronous command automatically.');
    return device;
  }

  server.registerTool('computer_task_submit', {
    description: 'Submit a durable task on another computer. Reuse the SAME key and parameters after an uncertain submission; a new key can execute again. Disconnecting does not cancel the task.',
    inputSchema: { computer: z.string(), key: z.string().min(1).max(128), command: z.string(), cwd: z.string().optional(), timeout: z.number().int().min(1).max(86400000).optional() },
  }, async ({ computer, cwd, ...payload }) => {
    const device = await taskDevice(computer);
    return text(await call(device, 'tasks.submit', { ...payload, cwd: await workingDirectory(context, device, cwd) }));
  });
  server.registerTool('computer_task_get', { description: 'Query a task by id; interrupted means the prior outcome is unknown and must not be retried automatically.', inputSchema: { computer: z.string(), task_id: z.string() } },
    async ({ computer, ...payload }) => text(await call(await taskDevice(computer), 'tasks.get', payload)));
  server.registerTool('computer_task_logs', { description: 'Read incremental stdout/stderr using next_cursor. Logs may contain task data.', inputSchema: { computer: z.string(), task_id: z.string(), cursor: z.number().int().min(0).optional() } },
    async ({ computer, ...payload }) => text(await call(await taskDevice(computer), 'tasks.logs', payload)));
  server.registerTool('computer_task_cancel', { description: 'Request cancellation of an AgentLink-owned task. Does not close independently launched user applications. Check status afterward.', inputSchema: { computer: z.string(), task_id: z.string() } },
    async ({ computer, ...payload }) => text(await call(await taskDevice(computer), 'tasks.cancel', payload)));

  server.registerTool('computer_health',
    { title: 'Diagnose a computer connection', description: 'Read-only authenticated connection check. Retries transient network failures up to three times; returns safe error codes and recovery guidance. Does not restart a computer, change network settings or replay commands.', inputSchema: { computer: z.string(), attempts: z.number().int().min(1).max(3).optional() } },
    async ({ computer, attempts }) => text(await inspectDevice(await resolveDevice(context, computer), { attempts: attempts ?? 3 })));

  server.registerTool('computer_list',
    { title: 'List computers', description: 'List the local machine and paired AgentLink computers, with online status and capabilities.', inputSchema: {} },
    async () => text(await context.list()));

  server.registerTool('computer_use',
    { title: 'Select the computer to work on', description: 'Set the current computer for this agent session. Later computer_* calls default to it. Use this before working on another machine.', inputSchema: { computer: z.string().describe('Computer name, e.g. RTX-PC, or the local machine name'), cwd: z.string().optional().describe('Optional absolute working directory on that computer') } },
    async ({ computer, cwd }) => text(await context.use(computer, cwd)));

  server.registerTool('computer_info',
    { title: 'Computer info', description: 'Show device identity, OS, architecture and capabilities. Defaults to the current context.', inputSchema: { computer: z.string().optional() } },
    async ({ computer }) => text(await context.info(computer)));

  server.registerTool('computer_exec',
    { title: 'Run a command', description: 'Run a shell command on a computer (PowerShell on Windows) and return exit_code/stdout/stderr.', inputSchema: { command: z.string(), computer: z.string().optional(), cwd: z.string().optional(), timeout: z.number().int().min(1).max(300000).optional() } },
    async ({ command, computer, cwd, timeout }) => {
      const device = await resolveDevice(context, computer);
      const result = await call(device, 'shell.run', { command, cwd: await workingDirectory(context, device, cwd), timeout: timeout ?? 30000 });
      return text(result);
    });

  server.registerTool('computer_file_list',
    { title: 'List files on a computer', description: 'List a directory on the selected remote computer.', inputSchema: { path: z.string(), computer: z.string().optional() } },
    async ({ path: remotePath, computer }) => {
      const device = await resolveDevice(context, computer);
      return text(await call(device, 'files.list', { path: remotePath }));
    });

  server.registerTool('computer_file_read_text',
    { title: 'Read a text file on a computer', description: 'Read a UTF-8 text file up to 1 MiB from the selected remote computer.', inputSchema: { path: z.string(), computer: z.string().optional() } },
    async ({ path: remotePath, computer }) => {
      const device = await resolveDevice(context, computer);
      const result = await call(device, 'files.read', { path: remotePath }) as { data:string };
      return text(Buffer.from(result.data, 'base64').toString('utf8'));
    });

  server.registerTool('computer_file_write_text',
    { title: 'Write a text file on a computer', description: 'Write UTF-8 text to a file on the selected remote computer. This replaces that file content but does not delete the file.', inputSchema: { path: z.string(), content: z.string(), computer: z.string().optional() } },
    async ({ path: remotePath, content, computer }) => {
      const device = await resolveDevice(context, computer);
      return text(await call(device, 'files.write', { path: remotePath, data:content, encoding:'utf8' }));
    });

  server.registerTool('computer_file_stat',
    { title: 'Inspect a file on a computer', description: 'Return metadata for a file or directory on the selected remote computer.', inputSchema: { path: z.string(), computer: z.string().optional() } },
    async ({ path: remotePath, computer }) => {
      const device = await resolveDevice(context, computer);
      return text(await call(device, 'files.stat', { path: remotePath }));
    });

  server.registerTool('computer_screen',
    { title: 'Capture screen', description: 'Capture a PNG screenshot of a computer and save it to a local file; returns the file path. Prefer computer_window_capture unless the whole screen is required.', inputSchema: { computer: z.string().optional(), monitor: z.number().int().min(0).optional(), output: z.string().optional() } },
    async ({ computer, monitor, output }) => {
      const device = await resolveDevice(context, computer);
      const png = await call(device, 'screen.capture', monitor === undefined ? {} : { monitor });
      if (!Buffer.isBuffer(png)) throw new Error('Invalid screenshot');
      const file = output ?? path.join(process.cwd(), 'agentlink-screen-' + device.name + '-' + Date.now() + '.png');
      await writeFile(file, png);
      return text({ saved: file, bytes: png.length });
    });

  server.registerTool('computer_app_launch',
    { title: 'Launch an app', description: 'Launch an application on a computer (executable path or registered name).', inputSchema: { app: z.string(), computer: z.string().optional(), cwd: z.string().optional(), args: z.array(z.string()).optional() } },
    async ({ app, computer, cwd, args }) => {
      const device = await resolveDevice(context, computer);
      const result = await call(device, 'apps.launch', { app, cwd: await workingDirectory(context, device, cwd), args: args ?? [] });
      return text(result);
    });

  server.registerTool('computer_app_find',
    { title: 'Find software on a computer', description: 'Find software on the selected Windows or Mac computer through its native application records or application bundles. Use this before guessing an app path or assuming software is missing. The lookup is live and read-only; portable apps outside standard locations may be absent.', inputSchema: { query: z.string().min(1).max(100), computer: z.string().optional(), cwd: z.string().optional() } },
    async ({ query, computer, cwd }) => {
      const device = await resolveDevice(context, computer);
      return text(await findNativeApp(device, query, await workingDirectory(context, device, cwd)));
    });

  server.registerTool('computer_windows',
    { title: 'List application windows', description: 'List visible application windows on a Windows computer. Use the returned window id with the window tools.', inputSchema: { computer: z.string().optional() } },
    async ({ computer }) => {
      const device = await resolveDevice(context, computer);
      return text(await call(device, 'window.list', {}));
    });

  server.registerTool('computer_window_capture',
    { title: 'Capture one application window', description: 'Capture only one Windows application window as a PNG and save it locally.', inputSchema: { id: z.string(), computer: z.string().optional(), output: z.string().optional() } },
    async ({ id, computer, output }) => {
      const device = await resolveDevice(context, computer);
      const png = await call(device, 'window.capture', { id });
      if (!Buffer.isBuffer(png)) throw new Error('Invalid window screenshot');
      const file = output ?? path.join(process.cwd(), 'agentlink-window-' + device.name + '-' + Date.now() + '.png');
      await writeFile(file, png);
      return text({ saved: file, bytes: png.length });
    });

  server.registerTool('computer_window_focus',
    { title: 'Focus a Windows application', description: 'Bring one Windows application window to the foreground.', inputSchema: { id: z.string(), computer: z.string().optional() } },
    async ({ id, computer }) => {
      const device = await resolveDevice(context, computer);
      return text(await call(device, 'window.focus', { id }));
    });

  server.registerTool('computer_window_input',
    { title: 'Operate a Windows application window', description: 'Send mouse, scroll, exact text, or a navigation key to one Windows application window. Coordinates are relative to that window. Prefer kind:"text" for long or non-ASCII input.', inputSchema: {
      id: z.string(), computer: z.string().optional(), kind: z.enum(['move','down','up','scroll','text','key']),
      x: z.number().optional(), y: z.number().optional(), button: z.enum(['left','right','middle']).optional(),
      delta: z.number().optional(), text: z.string().optional(), key: z.string().optional()
    } },
    async ({ id, computer, kind, x, y, button, delta, text: inputText, key }) => {
      const device = await resolveDevice(context, computer);
      return text(await call(device, 'window.input', { id, kind, x, y, button, delta, text: inputText, key }));
    });

  return server;
}
