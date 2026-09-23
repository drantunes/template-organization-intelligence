export function reportedUsage(
  value: unknown,
): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | 'unavailable' {
  if (typeof value !== 'object' || value === null) return 'unavailable';
  const fields = value as Record<string, unknown>;
  const number = (key: string) => {
    const field = fields[key];
    if (typeof field === 'number' && Number.isFinite(field)) return field;
    if (typeof field === 'object' && field !== null) {
      const total = (field as Record<string, unknown>).total;
      if (typeof total === 'number' && Number.isFinite(total)) return total;
    }
    return undefined;
  };
  const inputTokens = number('inputTokens') ?? number('promptTokens');
  const outputTokens = number('outputTokens') ?? number('completionTokens');
  const totalTokens =
    number('totalTokens') ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  return (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) ||
    (totalTokens === 0 && (inputTokens ?? 0) === 0 && (outputTokens ?? 0) === 0)
    ? 'unavailable'
    : { inputTokens, outputTokens, totalTokens };
}
