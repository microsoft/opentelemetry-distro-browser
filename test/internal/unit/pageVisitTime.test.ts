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

  it.each([false, true])(
    "consumes the predecessor before invoking a re-entrant reporter (write failure=%s)",
    (writeFailure) => {
      const storage = memoryStorage();
      const next = page(2, 2_000);
      const report = vi.fn((): void => {
        expect(storage.getItem(key)).toEqual({
          success: true,
          value: writeFailure ? null : JSON.stringify(visitOf(next)),
        });
        tracker.start(next);
      });
      const tracker = new PageVisitTime(storage, key, report);
      tracker.start(page(1, 1_000));
      if (writeFailure) vi.mocked(storage.setItem).mockReturnValue(false);

      tracker.start(next);

      expect(report).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "reports separate occurrences with the same trace ID (restored=%s)",
    (restored) => {
      const storage = memoryStorage();
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      const initial = page(1, 1_000);
      const next = { ...initial, name: "Next document", startTimeUnixMs: 8_000 };
      if (restored) storage.setItem(key, JSON.stringify(visitOf(initial)));
      else tracker.start(initial);

      tracker.start(next);
      tracker.start({ ...next, name: "Final next document" });

      expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(initial), 7_000);
      expect(storage.getItem(key)).toEqual({
        success: true,
        value: JSON.stringify({ ...visitOf(next), name: "Final next document" }),
      });
      tracker.stop();
      expect(storage.getItem(key)).toEqual({ success: true, value: null });
    },
  );

  it("defers startup visits until commit and clears the transaction before re-entrant reporting", () => {
    const storage = memoryStorage();
    const previous = page(1, 1_000);
    storage.setItem(key, JSON.stringify(visitOf(previous)));
    const report = vi.fn(() => tracker.commitStartup());
    const tracker = new PageVisitTime(storage, key, report);
    tracker.beginStartup();
    tracker.start(page(2, 2_000));
    tracker.start(page(3, 5_000));
    expect(report).not.toHaveBeenCalled();

    tracker.commitStartup();
    tracker.commitStartup();
    tracker.rollbackStartup();

    expect(report.mock.calls).toEqual([
      [visitOf(previous), 1_000],
      [visitOf(page(2, 2_000)), 3_000],
    ]);
    tracker.stop();
    expect(storage.getItem(key)).toEqual({ success: true, value: null });
  });

  it.each([false, true])(
    "restores the unsanitized predecessor after startup rollback (suspended=%s)",
    (suspended) => {
      const storage = memoryStorage();
      const previous = page(1, 1_000);
      const saved = JSON.stringify(visitOf(previous));
      storage.setItem(key, saved);
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report, (url) => `${url}/sanitized`);
      tracker.beginStartup();
      tracker.start(page(2, 2_000));
      tracker.start(page(3, 3_000));
      if (suspended) tracker.suspend();

      tracker.rollbackStartup();
      tracker.rollbackStartup();
      tracker.stop();
      tracker.commitStartup();

      expect(report).not.toHaveBeenCalled();
      expect(storage.getItem(key)).toEqual({ success: true, value: saved });
      const retry = new PageVisitTime(storage, key, report, (url) => `${url}/sanitized`);
      retry.beginStartup();
      retry.start(page(4, 5_000));
      retry.commitStartup();
      expect(report).toHaveBeenCalledExactlyOnceWith(
        { ...visitOf(previous), url: `${previous.url}/sanitized` },
        4_000,
      );
    },
  );

  it("rolls back an uncommitted startup when stop is called directly", () => {
    const storage = memoryStorage();
    const previous = page(1, 1_000);
    const saved = JSON.stringify(visitOf(previous));
    storage.setItem(key, saved);
    const report = vi.fn();
    const tracker = new PageVisitTime(storage, key, report);
    tracker.beginStartup();
    tracker.start(page(2, 2_000));

    tracker.stop();
    tracker.commitStartup();

    expect(report).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toEqual({ success: true, value: saved });
  });

  it.each(["rollbackStartup", "stop"] as const)(
    "%s preserves a seeded predecessor when successor writes fail and allows a retry",
    (cleanup) => {
      const storage = memoryStorage();
      const previous = page(1, 1_000);
      const saved = JSON.stringify(visitOf(previous));
      storage.setItem(key, saved);
      const write = vi.mocked(storage.setItem);
      const persist = write.getMockImplementation()!;
      write.mockReturnValue(false);
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      tracker.beginStartup();
      tracker.start(page(2, 2_000));
      tracker.start(page(3, 3_000));
      tracker.update({ ...page(3, 3_000), name: "Final name" });

      expect(storage.getItem(key)).toEqual({ success: true, value: saved });
      tracker[cleanup]();
      tracker.commitStartup();
      expect(report).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
      expect(storage.getItem(key)).toEqual({ success: true, value: saved });

      write.mockImplementation(persist);
      tracker.beginStartup();
      const retry = page(4, 5_000);
      tracker.start(retry);
      tracker.commitStartup();
      expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(previous), 4_000);
      expect(storage.getItem(key)).toEqual({
        success: true,
        value: JSON.stringify(visitOf(retry)),
      });
      tracker.start(page(5, 8_000));
      expect(report.mock.calls).toEqual([
        [visitOf(previous), 4_000],
        [visitOf(retry), 3_000],
      ]);
    },
  );

  it.each(["first", "last"])(
    "rolls back the last persisted owner when the %s successor write fails",
    (failure) => {
      const storage = memoryStorage();
      const saved = JSON.stringify(visitOf(page(1, 1_000)));
      storage.setItem(key, saved);
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      tracker.beginStartup();
      if (failure === "first") vi.mocked(storage.setItem).mockReturnValueOnce(false);
      tracker.start(page(2, 2_000));
      if (failure === "last") vi.mocked(storage.setItem).mockReturnValueOnce(false);
      tracker.start(page(3, 3_000));
      tracker.suspend();

      tracker.rollbackStartup();

      expect(report).not.toHaveBeenCalled();
      expect(storage.getItem(key)).toEqual({ success: true, value: saved });
    },
  );

  it.each([false, true])(
    "does not replay a consumed predecessor after a failed write (managed=%s)",
    (managed) => {
      const storage = memoryStorage();
      const previous = page(1, 1_000);
      storage.setItem(key, JSON.stringify(visitOf(previous)));
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      vi.mocked(storage.setItem).mockReturnValueOnce(false);
      if (managed) tracker.beginStartup();
      tracker.start(page(2, 2_000));
      if (managed) {
        tracker.suspend();
        tracker.commitStartup();
      }

      expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(previous), 1_000);
      expect(storage.getItem(key)).toEqual({ success: true, value: null });
      const next = new PageVisitTime(storage, key, report);
      next.start(page(3, 3_000));
      expect(report).toHaveBeenCalledTimes(1);
      next.start(page(4, 4_000));
      expect(report.mock.calls).toEqual([
        [visitOf(previous), 1_000],
        [visitOf(page(3, 3_000)), 1_000],
      ]);
    },
  );

  it("clears a consumed persisted owner on commit after a later successor write fails", () => {
    const storage = memoryStorage();
    const previous = page(1, 1_000);
    storage.setItem(key, JSON.stringify(visitOf(previous)));
    const report = vi.fn();
    const tracker = new PageVisitTime(storage, key, report);
    tracker.beginStartup();
    tracker.start(page(2, 2_000));
    vi.mocked(storage.setItem).mockReturnValueOnce(false);
    tracker.start(page(3, 3_000));

    tracker.commitStartup();
    new PageVisitTime(storage, key, report).start(page(4, 4_000));

    expect(report.mock.calls).toEqual([
      [visitOf(previous), 1_000],
      [visitOf(page(2, 2_000)), 1_000],
    ]);
  });

  it.each([
    ["standalone", false],
    ["commit", false],
    ["rollback", false],
    ["commit", true],
    ["rollback", true],
  ] as const)(
    "preserves a newer owner after a failed write and %s cleanup (prior successful write=%s)",
    (cleanup, persisted) => {
      const storage = memoryStorage();
      storage.setItem(key, JSON.stringify(visitOf(page(1, 1_000))));
      const write = vi.mocked(storage.setItem);
      const persist = write.getMockImplementation()!;
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      const successor = page(2, 2_000);
      const newer = JSON.stringify({ ...visitOf(successor), startTimeUnixMs: 3_000 });
      if (cleanup !== "standalone") {
        tracker.beginStartup();
        if (persisted) tracker.start(successor);
      }
      write.mockImplementationOnce(() => {
        persist(key, newer);
        return false;
      });
      tracker.start(page(3, 4_000));

      if (cleanup === "commit") tracker.commitStartup();
      else if (cleanup === "rollback") tracker.rollbackStartup();
      tracker.stop();

      expect(storage.getItem(key)).toEqual({ success: true, value: newer });
      if (cleanup === "rollback") expect(report).not.toHaveBeenCalled();
    },
  );

  it("removes a failed startup's successor when there was no predecessor", () => {
    const storage = memoryStorage();
    const tracker = new PageVisitTime(storage, key, vi.fn());
    tracker.beginStartup();
    tracker.start(page(1, 1_000));

    tracker.rollbackStartup();

    expect(storage.getItem(key)).toEqual({ success: true, value: null });
  });

  it.each(["stop", "rollbackStartup"] as const)(
    "%s preserves a newer owner with the same trace ID and a different start",
    (cleanup) => {
      const storage = memoryStorage();
      storage.setItem(key, JSON.stringify(visitOf(page(1, 1_000))));
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      if (cleanup === "rollbackStartup") tracker.beginStartup();
      const current = page(2, 2_000);
      tracker.start(current);
      const newer = { ...visitOf(current), startTimeUnixMs: 3_000 };
      const saved = JSON.stringify(newer);
      storage.setItem(key, saved);
      report.mockClear();

      tracker[cleanup]();
      tracker.stop();
      tracker.commitStartup();

      expect(storage.getItem(key)).toEqual({ success: true, value: saved });
      expect(report).not.toHaveBeenCalled();
    },
  );

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
