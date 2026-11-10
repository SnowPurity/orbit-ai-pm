import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadDemoConfig, projectRoot } from '../src/client.js';

const config = loadDemoConfig();
if (!config?.agentToken) {
  throw new Error('Run `npm run setup` first');
}

const root = projectRoot();
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
env.ORBIT_API_URL = process.env.ORBIT_API_URL ?? config.apiUrl;
env.ORBIT_TOKEN = config.agentToken;

const distEntry = path.join(root, 'dist', 'mcp.js');
const useDist = fs.existsSync(distEntry);
const transport = new StdioClientTransport({
  command: useDist ? process.execPath : path.join(root, 'node_modules', '.bin', 'tsx'),
  args: useDist ? [distEntry] : [path.join(root, 'src', 'mcp.ts')],
  env,
  cwd: root,
  stderr: 'pipe',
});
transport.stderr?.on('data', (chunk) => process.stderr.write(`[mcp] ${chunk}`));

const client = new Client({ name: 'orbit-smoke', version: '0.1.0' });
await client.connect(transport);

const tools = await client.listTools();
const names = tools.tools.map((tool) => tool.name);
assert(names.includes('list_projects'));
assert(names.includes('get_board'));
assert(names.includes('list_groups'));
assert(names.includes('get_group'));
assert(names.includes('update_group'));
assert(names.includes('delete_group'));
assert(names.includes('create_group'));
assert(names.includes('create_task'));
assert(names.includes('add_task_dependency'));
assert(names.includes('remove_task_dependency'));
assert(names.includes('request_ai_suggestion'));
assert(names.includes('get_automation'));
assert(names.includes('update_automation'));
assert(names.includes('delete_automation'));
assert(names.includes('create_automation'));
assert(names.includes('get_job'));
assert(names.includes('claim_job'));
assert.equal(names.length, 28);

const projects = await client.callTool({ name: 'list_projects', arguments: {} });
assert(!projects.isError);
const groups = await client.callTool({ name: 'list_groups', arguments: { project: 'IPD' } });
assert(!groups.isError);
const groupContent = JSON.parse(
  (groups.content as Array<{ type: string; text?: string }>)[0].text ?? '{}',
) as Array<{ name: string; taskCount: number }>;
assert.deepEqual(groupContent.map((group) => group.name), [
  '概念',
  '计划',
  '开发',
  '验证',
  '发布',
  '生命周期',
]);
assert(groupContent.every((group) => group.taskCount === 5));
const task = await client.callTool({ name: 'get_task', arguments: { task: 'ORB-2' } });
assert(!task.isError);
const content = task.content as Array<{ type: string; text?: string }>;
const parsed = JSON.parse(content[0].text ?? '{}') as {
  ref: string;
  subtasks: unknown[];
  dependencies: { predecessors: unknown[]; successors: unknown[] };
};
assert.equal(parsed.ref, 'ORB-2');
assert.equal(parsed.subtasks.length, 2);
assert(Array.isArray(parsed.dependencies.predecessors));

const board = await client.callTool({ name: 'get_board', arguments: { project: 'ORB' } });
assert(!board.isError);

const firstGroup = groupContent[0] as { id: string } | undefined;
if (firstGroup) {
  const group = await client.callTool({ name: 'get_group', arguments: { id: firstGroup.id } });
  assert(!group.isError);
}

const jobs = await client.callTool({ name: 'list_jobs', arguments: { project: 'ORB', limit: 1 } });
assert(!jobs.isError);
const jobRows = JSON.parse(
  (jobs.content as Array<{ type: string; text?: string }>)[0].text ?? '[]',
) as Array<{ id: string }>;
if (jobRows[0]) {
  const job = await client.callTool({ name: 'get_job', arguments: { id: jobRows[0].id } });
  assert(!job.isError);
}

console.log(
  `MCP smoke passed (${useDist ? 'dist' : 'src'}): ${names.length} tools, get_task(ORB-2) returned ${parsed.subtasks.length} subtasks, IPD has ${groupContent.length} task groups.`,
);
await client.close();
