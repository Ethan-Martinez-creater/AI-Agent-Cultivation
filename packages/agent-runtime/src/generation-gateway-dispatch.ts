import { DomainError } from '@cultivation/shared';
import { isGenerationAdapterId } from '@cultivation/domain';
import type { GenerationAdapterId } from '@cultivation/domain';
import type {
  GenerationGateway,
  GenerationOperationOptions,
  ProviderGenerationRequest,
} from '@cultivation/application/g1-generation';

/** Static Main composition, never renderer-registered code or arbitrary HTTP configuration. */
export class GenerationGatewayDispatch implements GenerationGateway {
  constructor(
    private readonly resolveAdapter: (runtimeId: string) => string | null,
    private readonly gateways: Readonly<Record<GenerationAdapterId, GenerationGateway>>,
  ) {}
  private gateway(runtimeId: string): GenerationGateway {
    const adapterId = this.resolveAdapter(runtimeId);
    if (!isGenerationAdapterId(adapterId))
      throw new DomainError('MODEL_NOT_FOUND', '生成服务适配器无效');
    return this.gateways[adapterId];
  }
  getDescriptor(id: string) {
    return this.gateway(id).getDescriptor(id);
  }
  submit(id: string, request: ProviderGenerationRequest) {
    return this.gateway(id).submit(id, request);
  }
  getJob(id: string, providerJobId: string) {
    return this.gateway(id).getJob(id, providerJobId);
  }
  downloadOutput(
    id: string,
    jobId: string,
    outputId: string,
    options?: GenerationOperationOptions,
  ) {
    return this.gateway(id).downloadOutput(id, jobId, outputId, options);
  }
}
