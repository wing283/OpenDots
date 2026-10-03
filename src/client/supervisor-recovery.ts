export type RecoveredSupervisorMessage = {
  id: string;
  role: 'assistant';
  content: string;
};

export function recoveredSupervisorMessage(
  value: unknown,
  existingIds: Iterable<string>,
): RecoveredSupervisorMessage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const role = raw.role === 'assistant' ? 'assistant' : '';
  const content =
    typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!id || !role || !content) return null;
  const ids = new Set(existingIds);
  if (ids.has(id)) return null;
  return { id, role, content };
}
