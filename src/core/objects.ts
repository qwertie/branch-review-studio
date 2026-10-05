/**
 * Assigns each property of `values` to `target`, except those that `target` already has: the same
 * value, or an array with the same items (compared with ===). Useful when each assignment has a
 * cost, e.g. ReviewCommentController's assignments to a VS Code comment thread, which make VS Code
 * redraw the thread's widget.
 */
export function assignChangedProperties<T, K extends keyof T>(target: T, values: Pick<T, K>): void {
  for (let key of Object.keys(values) as K[]) {
    if (!isSameOrHasSameItems(target[key], values[key]))
      target[key] = values[key];
  }
}

/** Checks whether two values are identical or are arrays of identical items. */
function isSameOrHasSameItems(a: unknown, b: unknown): boolean {
  return a === b
    || Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i]);
}
