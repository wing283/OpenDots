export type RecoveredSupervisorMessage = {
  id: string;
  role: 'assistant';
  content: string;
};

export function recoveredSupervisorMessage(
  value: unknown,
  existingMessages: Iterable<
    | string
    | {
        id?: string;
        role?: string;
        content?: unknown;
      }
  >,
): RecoveredSupervisorMessage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const role = raw.role === 'assistant' ? 'assistant' : '';
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!id || !role || !content) return null;

  const existing = [...existingMessages];
  const ids = new Set(
    existing.map((message) =>
      typeof message === 'string' ? message : String(message.id || ''),
    ),
  );
  if (ids.has(id)) return null;

  const latest = [...existing]
    .reverse()
    .find(
      (message) =>
        typeof message !== 'string' &&
        ['user', 'assistant'].includes(String(message.role || '')) &&
        typeof message.content === 'string' &&
        message.content.trim(),
    );
  if (
    latest &&
    typeof latest !== 'string' &&
    latest.role === 'assistant' &&
    typeof latest.content === 'string' &&
    latest.content.trim() === content
  )
    return null;

  return { id, role, content };
}
