export function buildEnvironmentValue(environment, name, fallback) {
  return environment[name]?.trim() || fallback;
}
