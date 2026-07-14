import type { EffectiveRule, ProviderConfig, Target } from "../contracts/config";
import type { BoundaryResult } from "../contracts/failure";

export interface ProviderContext {
  readonly directory: string;
  readonly rules: readonly EffectiveRule[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

export interface TargetProvider {
  resolve(config: ProviderConfig, context: ProviderContext): Promise<BoundaryResult<readonly Target[]>>;
}
