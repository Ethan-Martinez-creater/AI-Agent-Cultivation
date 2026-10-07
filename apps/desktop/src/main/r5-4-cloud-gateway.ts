import type { DecisionGateway } from '@cultivation/application/r0-decision';

/** Recheck opt-in across async SecretStore reads and immediately before dispatch. */
export async function resolveToolShortlistCloudGateway(options: {
  enabled: () => boolean;
  resolveKey: () => Promise<string | null>;
  create: (key: string) => DecisionGateway;
}): Promise<DecisionGateway | null> {
  if (!options.enabled()) return null;
  const key = await options.resolveKey();
  if (!key || !options.enabled()) return null;
  const gateway = options.create(key);
  return {
    evaluate(request) {
      if (!options.enabled()) return Promise.reject(new Error('Cloud decision disabled'));
      return gateway.evaluate(request);
    },
  };
}
