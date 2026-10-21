// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import { PageVisitTime } from "../../../src/instrumentation/pageView/pageVisitTime.js";
import type { PageView } from "../../../src/instrumentation/pageView/types.js";
import {
  createKeyValueStorage,
  type KeyValueStorage,
} from "../../../src/storage/keyValueStorage.js";

const key = "test.pageVisit";

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((name: string) => ({ success: true as const, value: values.get(name) ?? null })),
    setItem: vi.fn((name: string, value: string) => {
      values.set(name, value);
      return true;
    }),
    removeItem: vi.fn((name: string) => {
      values.delete(name);
      return true;
    }),
  };
}

function page(ordinal: number, startTimeUnixMs: number): PageView {
  return {
    id: ordinal.toString(16).padStart(32, "0"),
    index: ordinal - 1,
    name: `Page ${ordinal}`,
    nameSource: "explicit",
    url: `https://example.test/page-${ordinal}`,
    referrer: "",
    navigationType: "navigate",
    sameDocument: false,
    startTimeUnixMs,
  };
}

function visitOf(value: PageView) {
  const { id, name, url, startTimeUnixMs } = value;
  return { id, name, url, startTimeUnixMs };
}

describe("PageVisitTime", () => {
  it("bridges two documents through shared storage and consumes each visit once", () => {
    const storage = memoryStorage();
    const firstReport = vi.fn();
    const secondReport = vi.fn();
    const first = new PageVisitTime(storage, key, firstReport);
    const second = new PageVisitTime(storage, key, secondReport);
    const initial = page(1, 1_000);
    const next = page(2, 8_000);

    first.start(initial);
    first.suspend();
    second.start(next);
    second.start(next);

    expect(firstReport).not.toHaveBeenCalled();
    expect(secondReport).toHaveBeenCalledExactlyOnceWith(visitOf(initial), 7_000);
    expect(storage.getItem(key)).toEqual({
      success: true,
      value: JSON.stringify(visitOf(next)),
    });
  });

  it.each([true, false])("times SPA visits from page starts with persistence=%s", (persist) => {
    const report = vi.fn();
    const tracker = new PageVisitTime(persist ? memoryStorage() : null, key, report);
    const initial = page(1, 1_000);
    const next = page(2, 6_000);

    tracker.start(initial);
    tracker.update({ ...initial, name: "Finalized initial name" });
    tracker.start(next);
    tracker.start(next);
    tracker.start(page(3, 6_000));
    tracker.start(page(4, 6_001));

    expect(report.mock.calls).toEqual([
      [{ ...visitOf(initial), name: "Finalized initial name" }, 5_000],
      [visitOf(next), 0],
      [visitOf(page(3, 6_000)), 1],
    ]);
  });

  it("persists finalized names without restarting the previous page's clock", () => {
    const storage = memoryStorage();
    const report = vi.fn();
    const first = new PageVisitTime(storage, key, vi.fn());
    const initial = page(1, 1_000);
    first.start(initial);
    first.update({ ...initial, name: "Final route name", nameSource: "route" });
    first.suspend();

    new PageVisitTime(storage, key, report).start(page(2, 9_000));

    expect(report).toHaveBeenCalledExactlyOnceWith(
      { ...visitOf(initial), name: "Final route name" },
      8_000,
    );
  });

  it("commits the successor before invoking a re-entrant reporter", () => {
    const storage = memoryStorage();
    const next = page(2, 2_000);
    const report = vi.fn((): void => {
      expect(storage.getItem(key)).toEqual({
        success: true,
        value: JSON.stringify(visitOf(next)),
      });
      tracker.start(next);
    });
    const tracker = new PageVisitTime(storage, key, report);
    tracker.start(page(1, 1_000));

    tracker.start(next);

    expect(report).toHaveBeenCalledTimes(1);
  });

  it.each([
    "not JSON",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...visitOf(page(1, 1_000)), id: "not-a-trace-id" }),
    JSON.stringify({ ...visitOf(page(1, 1_000)), id: "0".repeat(32) }),
    JSON.stringify({ ...visitOf(page(1, 1_000)), name: null }),
    JSON.stringify({ ...visitOf(page(1, 1_000)), url: 123 }),
    JSON.stringify({ ...visitOf(page(1, 1_000)), startTimeUnixMs: "1000" }),
    JSON.stringify({ ...visitOf(page(1, 1_000)), startTimeUnixMs: null }),
    JSON.stringify(visitOf(page(1, 1_000))).replace("1000", "1e400"),
  ])("replaces corrupt or invalid persisted state without reporting it: %s", (serialized) => {
    const storage = memoryStorage();
    storage.setItem(key, serialized);
    const report = vi.fn();
    const tracker = new PageVisitTime(storage, key, report);
    const next = page(2, 2_000);

    expect(() => tracker.start(next)).not.toThrow();
    expect(report).not.toHaveBeenCalled();
    tracker.start(page(3, 3_000));
    expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(next), 1_000);
  });

  it.each([true, false])(
    "discards a future start without replaying it (persisted=%s)",
    (persisted) => {
      const storage = memoryStorage();
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      const future = page(1, 50_000);
      if (persisted) storage.setItem(key, JSON.stringify(visitOf(future)));
      else tracker.start(future);

      tracker.start(page(2, 2_000));
      expect(report).not.toHaveBeenCalled();
      tracker.start(page(3, 3_000));
      expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(page(2, 2_000)), 1_000);
    },
  );

  it.each(["read", "write", "remove", "all"] as const)(
    "keeps SPA timing in memory when Web Storage %s throws",
    (failure) => {
      const values = new Map<string, string>();
      const fail = (operation: string) => {
        if (failure === operation || failure === "all") throw new Error("Storage blocked");
      };
      vi.stubGlobal("sessionStorage", {
        getItem: (name: string) => {
          fail("read");
          return values.get(name) ?? null;
        },
        setItem: (name: string, value: string) => {
          fail("write");
          values.set(name, value);
        },
        removeItem: (name: string) => {
          fail("remove");
          values.delete(name);
        },
      });
      try {
        const storage = createKeyValueStorage("sessionStorage", "Visit storage unavailable");
        const report = vi.fn();
        const tracker = new PageVisitTime(storage, key, report);

        expect(() => {
          tracker.start(page(1, 1_000));
          tracker.start(page(2, 5_000));
          tracker.stop();
        }).not.toThrow();
        expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(page(1, 1_000)), 4_000);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("resumes BFCache from the successor document's persisted state, not stale memory", () => {
    const storage = memoryStorage();
    const originalReport = vi.fn();
    const successorReport = vi.fn();
    const original = new PageVisitTime(storage, key, originalReport);
    const successor = new PageVisitTime(storage, key, successorReport);
    original.start(page(1, 1_000));
    original.suspend();
    successor.start(page(2, 4_000));
    successor.suspend();

    original.start(page(3, 10_000));

    expect(successorReport).toHaveBeenCalledExactlyOnceWith(visitOf(page(1, 1_000)), 3_000);
    expect(originalReport).toHaveBeenCalledExactlyOnceWith(visitOf(page(2, 4_000)), 6_000);
    original.start(page(4, 11_000));
    expect(originalReport.mock.calls).toEqual([
      [visitOf(page(2, 4_000)), 6_000],
      [visitOf(page(3, 10_000)), 1_000],
    ]);
  });

  it("does not resurrect an in-memory visit after suspension without storage", () => {
    const report = vi.fn();
    const tracker = new PageVisitTime(null, key, report);
    tracker.start(page(1, 1_000));
    tracker.suspend();
    tracker.start(page(2, 10_000));
    expect(report).not.toHaveBeenCalled();
    tracker.start(page(3, 12_000));
    expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(page(2, 10_000)), 2_000);
  });

  it("does not replay stale memory when persisted state disappears while suspended", () => {
    const storage = memoryStorage();
    const report = vi.fn();
    const tracker = new PageVisitTime(storage, key, report);
    tracker.start(page(1, 1_000));
    tracker.suspend();
    storage.removeItem(key);

    tracker.start(page(2, 10_000));

    expect(report).not.toHaveBeenCalled();
    tracker.start(page(3, 12_000));
    expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(page(2, 10_000)), 2_000);
  });

  it("stop removes only its own active entry and never emits a final visit", () => {
    const storage = memoryStorage();
    const report = vi.fn();
    const first = new PageVisitTime(storage, key, report);
    const second = new PageVisitTime(storage, key, report);
    first.start(page(1, 1_000));
    second.start(page(2, 2_000));
    report.mockClear();

    first.stop();
    expect(storage.getItem(key)).toEqual({
      success: true,
      value: JSON.stringify(visitOf(page(2, 2_000))),
    });
    second.stop();
    expect(storage.getItem(key)).toEqual({ success: true, value: null });
    expect(report).not.toHaveBeenCalled();
  });

  it("stop preserves a suspended visit for the next document", () => {
    const storage = memoryStorage();
    const tracker = new PageVisitTime(storage, key, vi.fn());
    tracker.start(page(1, 1_000));
    tracker.suspend();
    tracker.stop();
    const report = vi.fn();
    new PageVisitTime(storage, key, report).start(page(2, 2_000));
    expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(page(1, 1_000)), 1_000);
  });

  it("isolates independent trackers with separate keys in the same storage", () => {
    const storage = memoryStorage();
    const firstReport = vi.fn();
    const secondReport = vi.fn();
    const first = new PageVisitTime(storage, "first", firstReport);
    const second = new PageVisitTime(storage, "second", secondReport);
    first.start(page(1, 1_000));
    second.start(page(2, 2_000));
    first.start(page(3, 5_000));
    first.stop();
    second.start(page(4, 8_000));
    expect(firstReport).toHaveBeenCalledExactlyOnceWith(visitOf(page(1, 1_000)), 4_000);
    expect(secondReport).toHaveBeenCalledExactlyOnceWith(visitOf(page(2, 2_000)), 6_000);
  });
});
