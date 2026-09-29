import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { R1CapabilityService } from '@cultivation/application/r1-capability-service';
import { BENCHMARK_SOURCE_CATALOG } from '@cultivation/application/r1-benchmark-source-catalog';

const id = z.string().min(1).max(128);
const dimension = z.enum([
  'GENERAL_REASONING',
  'LONG_CONTEXT_REASONING',
  'AGENTIC_EXECUTION',
  'CODING',
  'TOOL_USE',
  'VISUAL_UNDERSTANDING',
  'IMAGE_GENERATION',
  'IMAGE_EDITING',
  'VIDEO_GENERATION',
  'VIDEO_EDITING',
  'SPEECH_UNDERSTANDING',
  'SPEECH_GENERATION',
  'SPEECH_TO_SPEECH',
  'MUSIC_GENERATION',
]);
const benchmarkInput = z
  .object({
    runtimeProfileId: id,
    modelAlias: z.string().min(1).max(160),
    dimension,
    supported: z.boolean(),
    normalizedScore: z.number().min(0).max(100).nullable(),
    rawScore: z.number().finite().nullable(),
    source: z.string().min(1).max(200),
    benchmark: z.string().min(1).max(200),
    benchmarkVersion: z.string().min(1).max(100),
    snapshotDate: z.string().datetime(),
    sourceUrl: z
      .string()
      .url()
      .max(2000)
      .refine((value) => /^https?:\/\//i.test(value), '来源 URL 必须为 HTTP(S)')
      .nullable(),
    provenanceType: z.enum(['CATALOG', 'USER_OVERRIDE', 'USER_ESTIMATE']),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.supported === (value.normalizedScore === null)) {
      context.addIssue({ code: 'custom', message: 'supported 与 normalizedScore 不一致' });
    }
  });

export function registerR1Ipc(
  validSender: (event: IpcMainInvokeEvent) => boolean,
  service: R1CapabilityService,
): void {
  const register = (
    channel: string,
    handler: (args: unknown[]) => unknown | Promise<unknown>,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new Error('IPC sender denied');
      return handler(args);
    });
  };
  const one = <T>(args: unknown[], schema: z.ZodType<T>): T => {
    if (args.length !== 1) throw new Error('请求参数无效');
    return schema.parse(args[0]);
  };
  register('capability:catalog', (args) => {
    if (args.length !== 0) throw new Error('请求参数无效');
    return BENCHMARK_SOURCE_CATALOG;
  });
  register('capability:benchmarks', (args) => service.listBenchmarks(one(args, id)));
  register('capability:priors', (args) => service.listEffectivePriors(one(args, id)));
  register('capability:saveBenchmark', (args) => service.saveBenchmark(one(args, benchmarkInput)));
  ipcMain.removeHandler('capability:ratingTargets');
  ipcMain.removeHandler('capability:submitRating');
  register('capability:profile', (args) => service.profile(one(args, id)));
  register('capability:rebuild', (args) => service.rebuild(one(args, id)));
}
