import type { StaticProviderConfig, Target } from "../contracts/config";
import { boundarySuccess, type BoundaryResult } from "../contracts/failure";

export async function resolveStaticProvider(
  config: StaticProviderConfig,
): Promise<BoundaryResult<readonly Target[]>> {
  return boundarySuccess(config.targets);
}
