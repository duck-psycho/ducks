export function defined<T>(value: T | null | undefined): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error('Expected a defined value');
  }

  return value;
}
