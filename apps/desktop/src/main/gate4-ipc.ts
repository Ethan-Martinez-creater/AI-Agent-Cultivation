import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { Gate4ToolsService } from './gate4-tools-service.js';

const id = z.string().min(1).max(200);
const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
  .refine((name) => !/^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|LD_.*|DYLD_.*)$/i.test(name));
const serverInput = z
  .object({
    id: id.optional(),
    name: z.string().min(1).max(200),
    command: z.string().min(1).max(2048),
    args: z.array(z.string().max(8192)).max(128),
    envWhitelist: z
      .array(envName)
      .max(128)
      .refine((names) => new Set(names).size === names.length),
    cwd: z.string().min(1).max(4096).nullable(),
    enabled: z.boolean(),
  })
  .strict();

function one<T>(schema: z.ZodType<T>, args: unknown[]): T {
  if (args.length !== 1) throw new Error('请求参数无效');
  const parsed = schema.safeParse(args[0]);
  if (!parsed.success) throw new Error('请求参数无效');
  return parsed.data;
}

function noArgs(args: unknown[]): void {
  if (args.length !== 0) throw new Error('请求参数无效');
}

export function registerGate4Ipc(
  window: BrowserWindow,
  validSender: (event: IpcMainInvokeEvent) => boolean,
  tools: Gate4ToolsService,
): void {
  const register = (channel: string, handler: (args: unknown[]) => unknown | Promise<unknown>) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new Error('IPC sender denied');
      try {
        return await handler(args);
      } catch {
        throw new Error('Tool 配置或操作失败，请检查输入和状态');
      }
    });
  };
  register('tools:getWorkspace', (args) => {
    noArgs(args);
    return tools.getWorkspace();
  });
  register('tools:chooseWorkspace', (args) => {
    noArgs(args);
    return tools.chooseWorkspace(window);
  });
  register('tools:listBuiltins', (args) => {
    noArgs(args);
    return tools.listBuiltins();
  });
  register('tools:listMcpServers', (args) => {
    noArgs(args);
    return tools.listMcpServers();
  });
  register('tools:saveMcpServer', (args) => tools.saveMcpServer(one(serverInput, args)));
  register('tools:removeMcpServer', (args) => tools.removeMcpServer(one(id, args)));
  register('tools:refreshMcpServer', (args) => tools.refreshMcpServer(one(id, args)));
}
