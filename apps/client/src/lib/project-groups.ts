export function toggleCollapsedProject(
  current: Set<string>,
  projectId: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(projectId)) next.delete(projectId);
  else next.add(projectId);
  return next;
}

export function expandProject(
  current: Set<string>,
  projectId: string,
): Set<string> {
  if (!current.has(projectId)) return current;
  const next = new Set(current);
  next.delete(projectId);
  return next;
}

export function collapseProjects(projectIds: Iterable<string>): Set<string> {
  return new Set(projectIds);
}

export function expandAllProjects(): Set<string> {
  return new Set();
}
