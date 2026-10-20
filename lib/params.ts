// Small helpers shared by the query modules. Parameter validation lives in
// schemas.ts.

/** Page envelope modelled on Spring Data's `PagedModel` JSON. */
export function pageOf<T>(content: T[], { page, size }: { page: number; size: number }, totalElements: number) {
  return {
    content,
    page: { number: page, size, totalElements, totalPages: Math.ceil(totalElements / size) },
  };
}

/** Escapes LIKE wildcards so user input matches literally. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Collects bind parameters and hands out their `$n` placeholders. */
export class SqlParams {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}
