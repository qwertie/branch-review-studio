import { describe, expect, it } from "vitest";
import { assignChangedProperties } from "./objects";

describe("assignChangedProperties", () => {
  it("skips equal values and arrays with the same items; assigns other values", () => {
    let item = { id: 1 };
    let { target, assigned } = createAssignmentLog({ label: "a", state: 1 as number | undefined, items: [item] });
    assignChangedProperties(target, { label: "a", state: 1, items: [item] });
    expect(assigned).toEqual([]);
    assignChangedProperties(target, { label: "b", state: undefined, items: [{ id: 1 }] });
    expect(assigned.splice(0)).toEqual(["label", "state", "items"]);
    assignChangedProperties(target, { items: [...target.items, item] });
    expect(assigned).toEqual(["items"]);
    expect(target).toEqual({ label: "b", state: undefined, items: [{ id: 1 }, item] });
  });
});

/** Wraps `values` in a proxy that records the names of the properties assigned to it. */
function createAssignmentLog<T extends object>(values: T): { target: T, assigned: (string | symbol)[] } {
  let assigned: (string | symbol)[] = [];
  let target = new Proxy(values, {
    set: (object, key, value) => {
      assigned.push(key);
      return Reflect.set(object, key, value);
    },
  });
  return { target, assigned };
}
