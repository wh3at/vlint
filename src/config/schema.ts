import type {
  CommandProviderConfig,
  CommandProviderOutput,
  ConfigV2,
  DeviceProfile,
  ProviderConfig,
  ReadyCondition,
  RuleInstance,
  RuleOverride,
  StaticProviderConfig,
  Target,
  TargetDefaults,
  Viewport,
} from "../contracts/config";
import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
  type Failure,
} from "../contracts/failure";

const NAME_BYTES = 1024;
const TEXT_BYTES = 64 * 1024;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;

class SchemaIssue extends Error {}

type Source = "config" | "provider";

function issue(path: string, message: string): never {
  throw new SchemaIssue(`${path}: ${message}`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issue(path, "expected object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(object: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const keys = Object.keys(object);
  for (const key of keys) {
    if (!allowed.includes(key)) issue(`${path}.${key}`, "unknown field");
  }
}

function stringAt(value: unknown, path: string, maxBytes = TEXT_BYTES): string {
  if (typeof value !== "string") issue(path, "expected string");
  if (new TextEncoder().encode(value).byteLength > maxBytes) issue(path, "value is too large");
  return value;
}

function nameAt(value: unknown, path: string): string {
  const name = stringAt(value, path, NAME_BYTES);
  if (name.length === 0) issue(path, "must not be empty");
  return name;
}

function integerAt(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    issue(path, `expected integer ${minimum}..${maximum}`);
  }
  return value as number;
}

function finiteNumberAt(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    issue(path, `expected finite number ${minimum}..${maximum}`);
  }
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") issue(path, "expected boolean");
  return value;
}

function stringArrayAt(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) issue(path, "expected array");
  return value.map((item, index) => stringAt(item, `${path}[${index}]`));
}

function viewportAt(value: unknown, path: string): Viewport {
  const object = objectAt(value, path);
  exactKeys(object, ["width", "height"], path);
  return {
    width: integerAt(object.width, `${path}.width`, 1, 10_000),
    height: integerAt(object.height, `${path}.height`, 1, 10_000),
  };
}

function readyConditionAt(value: unknown, path: string): ReadyCondition {
  const object = objectAt(value, path);
  exactKeys(object, ["selector", "state"], path);
  const selector = stringAt(object.selector, `${path}.selector`);
  if (object.state === undefined) return { selector };
  if (object.state !== "attached" && object.state !== "visible" && object.state !== "hidden") {
    issue(`${path}.state`, "expected attached, visible, or hidden");
  }
  return { selector, state: object.state };
}

function localeAt(value: unknown, path: string): string {
  const locale = stringAt(value, path);
  try {
    Intl.getCanonicalLocales(locale);
  } catch {
    issue(path, "invalid BCP 47 locale");
  }
  return locale;
}

function timezoneAt(value: unknown, path: string): string {
  const timezone = stringAt(value, path);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    issue(path, "invalid IANA timezone");
  }
  return timezone;
}

function defaultsAt(value: unknown, path: string, validateKeys = true): TargetDefaults {
  const object = objectAt(value, path);
  if (validateKeys) {
    exactKeys(object, ["locale", "timezoneId", "timeoutMs", "browserState", "readyCondition"], path);
  }
  const result: {
    locale?: string;
    timezoneId?: string;
    timeoutMs?: number;
    browserState?: string;
    readyCondition?: ReadyCondition;
  } = {};
  if (object.locale !== undefined) result.locale = localeAt(object.locale, `${path}.locale`);
  if (object.timezoneId !== undefined) result.timezoneId = timezoneAt(object.timezoneId, `${path}.timezoneId`);
  if (object.timeoutMs !== undefined) {
    result.timeoutMs = integerAt(object.timeoutMs, `${path}.timeoutMs`, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  }
  if (object.browserState !== undefined) {
    const browserState = stringAt(object.browserState, `${path}.browserState`);
    if (browserState.length === 0 || browserState.includes("\0")) issue(`${path}.browserState`, "invalid path");
    result.browserState = browserState;
  }
  if (object.readyCondition !== undefined) {
    result.readyCondition = readyConditionAt(object.readyCondition, `${path}.readyCondition`);
  }
  return result;
}

function ruleOverrideAt(value: unknown, path: string): RuleOverride {
  const object = objectAt(value, path);
  exactKeys(object, ["enabled", "excludeSelectors", "minimumLabels"], path);
  const result: { enabled?: boolean; excludeSelectors?: readonly string[]; minimumLabels?: number } = {};
  if (object.enabled !== undefined) result.enabled = booleanAt(object.enabled, `${path}.enabled`);
  if (object.excludeSelectors !== undefined) {
    result.excludeSelectors = stringArrayAt(object.excludeSelectors, `${path}.excludeSelectors`);
  }
  if (object.minimumLabels !== undefined) {
    result.minimumLabels = integerAt(object.minimumLabels, `${path}.minimumLabels`, 0, 100_000);
  }
  return result;
}

function urlAt(value: unknown, path: string): string {
  const text = stringAt(value, path);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    issue(path, "expected absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") issue(path, "unsupported URL protocol");
  if (parsed.username.length > 0 || parsed.password.length > 0) issue(path, "URL userinfo is forbidden");
  return text;
}

function targetAt(value: unknown, path: string, ruleNames: ReadonlySet<string>): Target {
  const object = objectAt(value, path);
  exactKeys(
    object,
    ["name", "url", "locale", "timezoneId", "timeoutMs", "browserState", "readyCondition", "ruleOverrides"],
    path,
  );
  const base = defaultsAt(object, path, false);
  const result: Target = {
    ...base,
    name: nameAt(object.name, `${path}.name`),
    url: urlAt(object.url, `${path}.url`),
  };
  if (object.ruleOverrides === undefined) return result;
  const overridesObject = objectAt(object.ruleOverrides, `${path}.ruleOverrides`);
  const overrides: Record<string, RuleOverride> = {};
  for (const [name, rawOverride] of Object.entries(overridesObject)) {
    if (!ruleNames.has(name)) issue(`${path}.ruleOverrides.${name}`, "unknown rule name");
    overrides[name] = ruleOverrideAt(rawOverride, `${path}.ruleOverrides.${name}`);
  }
  return { ...result, ruleOverrides: overrides };
}

function targetsAt(
  value: unknown,
  path: string,
  ruleNames: ReadonlySet<string>,
  allowEmpty: boolean,
): readonly Target[] {
  if (!Array.isArray(value)) issue(path, "expected array");
  if (!allowEmpty && value.length === 0) issue(path, "must contain at least one target");
  const targets = value.map((item, index) => targetAt(item, `${path}[${index}]`, ruleNames));
  const names = new Set<string>();
  for (const target of targets) {
    if (names.has(target.name)) issue(path, `duplicate target name: ${target.name}`);
    names.add(target.name);
  }
  return targets;
}

function deviceAt(value: unknown, path: string): DeviceProfile {
  const object = objectAt(value, path);
  exactKeys(
    object,
    ["name", "viewport", "screen", "deviceScaleFactor", "isMobile", "hasTouch", "userAgent"],
    path,
  );
  const result: DeviceProfile = {
    name: nameAt(object.name, `${path}.name`),
    viewport: viewportAt(object.viewport, `${path}.viewport`),
    screen: viewportAt(object.screen, `${path}.screen`),
    deviceScaleFactor: finiteNumberAt(object.deviceScaleFactor, `${path}.deviceScaleFactor`, 0.1, 10),
    isMobile: booleanAt(object.isMobile, `${path}.isMobile`),
    hasTouch: booleanAt(object.hasTouch, `${path}.hasTouch`),
  };
  if (object.userAgent === undefined) return result;
  const userAgent = stringAt(object.userAgent, `${path}.userAgent`);
  if (userAgent.length === 0) issue(`${path}.userAgent`, "must not be empty");
  return { ...result, userAgent };
}

function devicesAt(value: unknown, path: string): readonly DeviceProfile[] {
  if (!Array.isArray(value) || value.length === 0) issue(path, "expected non-empty array");
  const devices = value.map((item, index) => deviceAt(item, `${path}[${index}]`));
  const names = new Set<string>();
  for (const device of devices) {
    if (names.has(device.name)) issue(path, `duplicate device name: ${device.name}`);
    names.add(device.name);
  }
  return devices;
}

function ruleAt(value: unknown, path: string): RuleInstance {
  const object = objectAt(value, path);
  exactKeys(
    object,
    ["name", "type", "additionalCandidateSelectors", "excludeSelectors", "labelSelector", "minimumLabels", "allowZeroLabels"],
    path,
  );
  if (object.type !== "tab-label-single-line") issue(`${path}.type`, "unsupported rule type");
  const result: {
    name: string;
    type: "tab-label-single-line";
    additionalCandidateSelectors?: readonly string[];
    excludeSelectors?: readonly string[];
    labelSelector?: string;
    minimumLabels?: number;
    allowZeroLabels?: boolean;
  } = {
    name: nameAt(object.name, `${path}.name`),
    type: "tab-label-single-line",
  };
  if (object.additionalCandidateSelectors !== undefined) {
    result.additionalCandidateSelectors = stringArrayAt(
      object.additionalCandidateSelectors,
      `${path}.additionalCandidateSelectors`,
    );
  }
  if (object.excludeSelectors !== undefined) {
    result.excludeSelectors = stringArrayAt(object.excludeSelectors, `${path}.excludeSelectors`);
  }
  if (object.labelSelector !== undefined) result.labelSelector = stringAt(object.labelSelector, `${path}.labelSelector`);
  if (object.minimumLabels !== undefined) {
    result.minimumLabels = integerAt(object.minimumLabels, `${path}.minimumLabels`, 0, 100_000);
  }
  if (object.allowZeroLabels !== undefined) {
    result.allowZeroLabels = booleanAt(object.allowZeroLabels, `${path}.allowZeroLabels`);
  }
  return result;
}

function rulesAt(value: unknown, path: string): readonly RuleInstance[] {
  if (!Array.isArray(value) || value.length === 0) issue(path, "expected non-empty array");
  const rules = value.map((item, index) => ruleAt(item, `${path}[${index}]`));
  const names = new Set<string>();
  for (const rule of rules) {
    if (names.has(rule.name)) issue(path, `duplicate rule name: ${rule.name}`);
    names.add(rule.name);
  }
  return rules;
}

function providerAt(value: unknown, path: string, ruleNames: ReadonlySet<string>): ProviderConfig {
  const object = objectAt(value, path);
  if (object.type === "static") {
    exactKeys(object, ["type", "targets"], path);
    const provider: StaticProviderConfig = {
      type: "static",
      targets: targetsAt(object.targets, `${path}.targets`, ruleNames, false),
    };
    return provider;
  }
  if (object.type === "command") {
    exactKeys(object, ["type", "executable", "args", "timeoutMs"], path);
    const executable = stringAt(object.executable, `${path}.executable`);
    if (executable.length === 0 || executable.includes("\0")) issue(`${path}.executable`, "invalid executable");
    const result: { type: "command"; executable: string; args?: readonly string[]; timeoutMs?: number } = {
      type: "command",
      executable,
    };
    if (object.args !== undefined) result.args = stringArrayAt(object.args, `${path}.args`);
    if (object.timeoutMs !== undefined) {
      result.timeoutMs = integerAt(object.timeoutMs, `${path}.timeoutMs`, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    }
    return result as CommandProviderConfig;
  }
  issue(`${path}.type`, "expected static or command");
}

function failureFor(source: Source, message: string): Failure {
  return {
    stage: source,
    code: source === "config" ? "config-schema-invalid" : "provider-output-invalid",
    message,
    target: null,
    device: null,
    rule: null,
  };
}

export function parseConfig(value: unknown): BoundaryResult<ConfigV2> {
  try {
    const object = objectAt(value, "config");
    exactKeys(object, ["schemaVersion", "devices", "provider", "defaults", "rules"], "config");
    if (object.schemaVersion !== 2) issue("config.schemaVersion", "expected 2");
    const rules = object.rules === undefined ? undefined : rulesAt(object.rules, "config.rules");
    const ruleNames = new Set((rules ?? [{ name: "tab-label-single-line" }]).map((rule) => rule.name));
    const devices = devicesAt(object.devices, "config.devices");
    const config: {
      schemaVersion: 2;
      devices: readonly DeviceProfile[];
      provider?: ProviderConfig;
      defaults?: TargetDefaults;
      rules?: readonly RuleInstance[];
    } = { schemaVersion: 2, devices };
    if (object.provider !== undefined) config.provider = providerAt(object.provider, "config.provider", ruleNames);
    if (object.defaults !== undefined) config.defaults = defaultsAt(object.defaults, "config.defaults");
    if (rules !== undefined) config.rules = rules;
    return boundarySuccess(config);
  } catch (error) {
    const message = error instanceof SchemaIssue ? error.message : "config schema validation failed";
    return boundaryFailure(failureFor("config", message));
  }
}

export function parseCommandProviderOutput(
  value: unknown,
  ruleNames: ReadonlySet<string>,
): BoundaryResult<CommandProviderOutput> {
  try {
    const object = objectAt(value, "providerOutput");
    exactKeys(object, ["targets"], "providerOutput");
    const targets = targetsAt(object.targets, "providerOutput.targets", ruleNames, true);
    if (targets.length === 0) {
      return boundaryFailure({
        stage: "provider",
        code: "provider-empty",
        message: "provider returned zero targets",
        target: null,
        device: null,
        rule: null,
      });
    }
    return boundarySuccess({ targets });
  } catch (error) {
    const message = error instanceof SchemaIssue ? error.message : "provider output validation failed";
    return boundaryFailure(failureFor("provider", message));
  }
}

export function parseAdHocUrl(value: string): BoundaryResult<string> {
  try {
    return boundarySuccess(urlAt(value, "url"));
  } catch (error) {
    const message = error instanceof SchemaIssue ? error.message : "invalid URL";
    return boundaryFailure(failureFor("config", message));
  }
}
