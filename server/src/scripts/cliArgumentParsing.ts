export function splitCliArgument(argument: string): { key: string; value: string | undefined } {
  const separator = argument.indexOf('=');
  if (separator < 0) return { key: argument, value: undefined };
  return {
    key: argument.slice(0, separator),
    value: argument.slice(separator + 1)
  };
}

export function boundedIntegerArgument(params: {
  value: string | undefined;
  name: string;
  defaultValue: number;
  min: number;
  max: number;
}): number {
  const raw = params.value?.trim();
  if (!raw) return params.defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${params.name} must be an integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < params.min || parsed > params.max) {
    throw new Error(`${params.name} must be between ${params.min} and ${params.max}`);
  }
  return parsed;
}

export function booleanArgument(
  value: string | undefined,
  name: string,
  defaultValue: boolean
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be true or false`);
}
