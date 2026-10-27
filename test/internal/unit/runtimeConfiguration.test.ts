// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeConfiguration,
  type MicrosoftOpenTelemetryBrowserConfigurationUpdate,
} from "../../../src/configuration/runtimeConfiguration.js";

const invalid = (value: unknown) => value as MicrosoftOpenTelemetryBrowserConfigurationUpdate;

function create(initial: MicrosoftOpenTelemetryBrowserConfigurationUpdate = {}) {
  let stopped = false;
  const controller = createRuntimeConfiguration(initial, () => stopped);
  return {
    controller,
    stop: () => {
      stopped = true;
    },
  };
}

describe("sampling configuration", () => {
  it("starts with a frozen default or explicit initial policy", () => {
    const { controller } = create();
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
    expect(Object.isFrozen(controller.snapshot())).toBe(true);
    expect(create({ samplingPercentage: 0 }).controller.snapshot().samplingPercentage).toBe(0);
  });

  it("commits sequential revisions and preserves snapshots", async () => {
    const { controller } = create();
    const original = controller.snapshot();
    const first = controller.updateCfg({ samplingPercentage: 25 });
    const second = controller.updateCfg({ samplingPercentage: 0 });
    expect(controller.snapshot()).toBe(original);
    expect(await first).toEqual({ revision: 1, changedPaths: ["samplingPercentage"] });
    expect(await second).toEqual({ revision: 2, changedPaths: ["samplingPercentage"] });
    expect(controller.snapshot().samplingPercentage).toBe(0);
    expect(original.samplingPercentage).toBeUndefined();
  });

  it("captures queued input and freezes results", async () => {
    const { controller } = create();
    const patch = { samplingPercentage: 25 };
    const operation = controller.updateCfg(patch);
    patch.samplingPercentage = 90;
    const result = await operation;
    expect(controller.snapshot().samplingPercentage).toBe(25);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.changedPaths)).toBe(true);
  });

  it("distinguishes omission, explicit undefined and replacement resets", async () => {
    const { controller } = create({ samplingPercentage: 50 });
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
    expect(await controller.updateCfg({ samplingPercentage: undefined })).toEqual({
      revision: 1,
      changedPaths: ["samplingPercentage"],
    });
    await controller.updateCfg({ samplingPercentage: 100 });
    expect(await controller.updateCfg({ samplingPercentage: 100 })).toEqual({
      revision: 2,
      changedPaths: [],
    });
    expect(await controller.updateCfg({}, false)).toEqual({
      revision: 3,
      changedPaths: ["samplingPercentage"],
    });
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
  });

  it.each([NaN, Infinity, -1, 101, "25", null, true])(
    "rejects invalid percentages: %s",
    async (value) => {
      const { controller } = create({ samplingPercentage: 50 });
      await expect(controller.updateCfg(invalid({ samplingPercentage: value }))).rejects.toThrow();
      expect(controller.snapshot().samplingPercentage).toBe(50);
      expect(await controller.updateCfg({ samplingPercentage: 25 })).toEqual({
        revision: 1,
        changedPaths: ["samplingPercentage"],
      });
    },
  );

  it.each([null, [], 1, "config", new Date(), { azureMonitor: {} }])(
    "rejects unsupported patches: %s",
    async (value) => {
      const { controller } = create();
      await expect(controller.updateCfg(invalid(value))).rejects.toThrow();
      expect(controller.snapshot().samplingPercentage).toBeUndefined();
    },
  );

  it("rejects mixed valid/unsupported fields before queuing any change", async () => {
    const { controller } = create({ samplingPercentage: 50 });
    await expect(
      controller.updateCfg(invalid({ samplingPercentage: 0, resource: {} })),
    ).rejects.toThrow("Unsupported configuration path: resource");
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  });

  it("rejects accessors, inherited options, symbols and pollution keys without executing getters", async () => {
    const { controller } = create();
    const getter = vi.fn(() => 25);
    const accessor = Object.defineProperty({}, "samplingPercentage", { get: getter });
    await expect(controller.updateCfg(accessor)).rejects.toThrow("data property");
    expect(getter).not.toHaveBeenCalled();
    await expect(
      controller.updateCfg(invalid(Object.create({ samplingPercentage: 0 }))),
    ).rejects.toThrow("plain object");
    await expect(
      controller.updateCfg(invalid({ [Symbol("samplingPercentage")]: 0 })),
    ).rejects.toThrow("Unsupported");
    await expect(controller.updateCfg(invalid(JSON.parse('{"__proto__":{}}')))).rejects.toThrow(
      "Unsupported",
    );
  });

  it("accepts null-prototype data without exposing a mutable snapshot", async () => {
    const { controller } = create();
    const patch = Object.create(null) as MicrosoftOpenTelemetryBrowserConfigurationUpdate;
    patch.samplingPercentage = 25;
    await controller.updateCfg(patch);
    expect(controller.snapshot().samplingPercentage).toBe(25);
  });

  it("validates mergeExisting and initial values", async () => {
    const { controller } = create();
    await expect(controller.updateCfg({}, undefined as unknown as boolean)).resolves.toEqual({
      revision: 0,
      changedPaths: [],
    });
    await expect(controller.updateCfg({}, 1 as unknown as boolean)).rejects.toThrow(
      "mergeExisting",
    );
    expect(() => create({ samplingPercentage: NaN })).toThrow();
  });

  it("rejects pending and future changes immediately after shutdown begins", async () => {
    const { controller, stop } = create();
    const original = controller.snapshot();
    const queued = controller.updateCfg({
      samplingPercentage: 0,
      session: { inactivityTimeout: 0, maxDuration: 0 },
    });
    stop();
    await expect(queued).rejects.toThrow("stopped");
    await expect(
      controller.updateCfg({ sessionRenewalMs: 1000, sessionExpirationMs: 2000 }),
    ).rejects.toThrow("stopped");
    expect(controller.snapshot()).toBe(original);
  });
});

describe("session lifetime configuration", () => {
  const defaults = { inactivityTimeout: 1800, maxDuration: 86400 };
  const changedPaths = ["samplingPercentage", "session.inactivityTimeout", "session.maxDuration"];
  const initial = {
    samplingPercentage: 50,
    session: { inactivityTimeout: 60, maxDuration: 120 },
  };

  it.each(["sessionRenewalMs", "sessionExpirationMs"] as const)(
    "rejects positive %s values that underflow rather than disabling expiration",
    async (alias) => {
      const { controller } = create(initial);
      const original = controller.snapshot();
      await expect(controller.updateCfg({ [alias]: Number.MIN_VALUE })).rejects.toThrow(
        "too small to represent",
      );
      expect(controller.snapshot()).toBe(original);
    },
  );

  it.each([
    { patch: {}, session: defaults },
    { patch: { session: {} }, session: defaults },
    { patch: { session: undefined }, session: defaults },
    {
      patch: { session: { inactivityTimeout: undefined, maxDuration: undefined } },
      session: defaults,
    },
    {
      patch: { session: { inactivityTimeout: 0, maxDuration: 0 } },
      session: { inactivityTimeout: 0, maxDuration: 0 },
    },
    { patch: { sessionRenewalMs: 0, sessionExpirationMs: 0 }, session: defaults },
    { patch: { sessionRenewalMs: undefined, sessionExpirationMs: undefined }, session: defaults },
    {
      patch: { sessionRenewalMs: 1500, sessionExpirationMs: 2250 },
      session: { inactivityTimeout: 1.5, maxDuration: 2.25 },
    },
    {
      patch: { session: { inactivityTimeout: 0.5, maxDuration: 1.25 } },
      session: { inactivityTimeout: 0.5, maxDuration: 1.25 },
    },
  ])("normalizes initial lifetimes: $patch", ({ patch, session }) => {
    const { controller } = create(patch);
    expect(controller.snapshot()).toEqual({ samplingPercentage: undefined, session });
    expect(Object.isFrozen(controller.snapshot())).toBe(true);
    expect(Object.isFrozen(controller.snapshot().session)).toBe(true);
  });

  it("treats an empty session patch as a supported no-op", async () => {
    const { controller } = create(initial);
    const original = controller.snapshot();
    expect(await controller.updateCfg({ session: {} })).toEqual({ revision: 0, changedPaths: [] });
    expect(controller.snapshot()).toBe(original);
  });

  it.each([
    { patch: { session: undefined }, session: defaults, paths: changedPaths.slice(1) },
    {
      patch: { session: { inactivityTimeout: undefined } },
      session: { inactivityTimeout: 1800, maxDuration: 120 },
      paths: ["session.inactivityTimeout"],
    },
    {
      patch: { session: { maxDuration: undefined } },
      session: { inactivityTimeout: 60, maxDuration: 86400 },
      paths: ["session.maxDuration"],
    },
    {
      patch: { sessionRenewalMs: undefined },
      session: { inactivityTimeout: 1800, maxDuration: 120 },
      paths: ["session.inactivityTimeout"],
    },
    {
      patch: { sessionExpirationMs: undefined },
      session: { inactivityTimeout: 60, maxDuration: 86400 },
      paths: ["session.maxDuration"],
    },
    {
      patch: { sessionRenewalMs: 0 },
      session: { inactivityTimeout: 1800, maxDuration: 120 },
      paths: ["session.inactivityTimeout"],
    },
    {
      patch: { sessionExpirationMs: 0 },
      session: { inactivityTimeout: 60, maxDuration: 86400 },
      paths: ["session.maxDuration"],
    },
  ])(
    "resets only the requested lifetimes when merging: $patch",
    async ({ patch, session, paths }) => {
      const { controller } = create(initial);
      expect(await controller.updateCfg(patch)).toEqual({ revision: 1, changedPaths: paths });
      expect(controller.snapshot()).toEqual({ samplingPercentage: 50, session });
      expect(await controller.updateCfg(patch)).toEqual({ revision: 1, changedPaths: [] });
    },
  );

  it("distinguishes native zero from alias zero on both lifetime checks", async () => {
    const { controller } = create();
    expect(
      await controller.updateCfg({ session: { inactivityTimeout: 0, maxDuration: 0 } }),
    ).toEqual({
      revision: 1,
      changedPaths: changedPaths.slice(1),
    });
    expect(controller.snapshot().session).toEqual({ inactivityTimeout: 0, maxDuration: 0 });
    expect(await controller.updateCfg({ sessionRenewalMs: 0, sessionExpirationMs: 0 })).toEqual({
      revision: 2,
      changedPaths: changedPaths.slice(1),
    });
    expect(controller.snapshot().session).toEqual(defaults);
  });

  it.each([
    { patch: {}, samplingPercentage: undefined, session: defaults, paths: changedPaths },
    {
      patch: { session: {} },
      samplingPercentage: undefined,
      session: defaults,
      paths: changedPaths,
    },
    {
      patch: { samplingPercentage: 25 },
      samplingPercentage: 25,
      session: defaults,
      paths: changedPaths,
    },
    {
      patch: { samplingPercentage: 50 },
      samplingPercentage: 50,
      session: defaults,
      paths: changedPaths.slice(1),
    },
    {
      patch: { session: { inactivityTimeout: 60 } },
      samplingPercentage: undefined,
      session: { inactivityTimeout: 60, maxDuration: 86400 },
      paths: ["samplingPercentage", "session.maxDuration"],
    },
    {
      patch: { session: { maxDuration: 120 } },
      samplingPercentage: undefined,
      session: { inactivityTimeout: 1800, maxDuration: 120 },
      paths: ["samplingPercentage", "session.inactivityTimeout"],
    },
    {
      patch: { sessionRenewalMs: 60000 },
      samplingPercentage: undefined,
      session: { inactivityTimeout: 60, maxDuration: 86400 },
      paths: ["samplingPercentage", "session.maxDuration"],
    },
    {
      patch: { sessionExpirationMs: 120000 },
      samplingPercentage: undefined,
      session: { inactivityTimeout: 1800, maxDuration: 120 },
      paths: ["samplingPercentage", "session.inactivityTimeout"],
    },
  ])(
    "resets all omitted supported fields when replacing: $patch",
    async ({ patch, samplingPercentage, session, paths }) => {
      const { controller } = create(initial);
      expect(await controller.updateCfg(patch, false)).toEqual({
        revision: 1,
        changedPaths: paths,
      });
      expect(controller.snapshot()).toEqual({ samplingPercentage, session });
      expect(await controller.updateCfg(patch, false)).toEqual({ revision: 1, changedPaths: [] });
    },
  );

  it.each([
    {
      session: { inactivityTimeout: 1.5, maxDuration: 2.25 },
      sessionRenewalMs: 1500,
      sessionExpirationMs: 2250,
    },
    { session: defaults, sessionRenewalMs: 0, sessionExpirationMs: 0 },
    {
      session: { inactivityTimeout: undefined, maxDuration: undefined },
      sessionRenewalMs: undefined,
      sessionExpirationMs: undefined,
    },
    { session: undefined, sessionRenewalMs: 1800000, sessionExpirationMs: 86400000 },
  ])("accepts equal native and alias values after normalization: %s", async (patch) => {
    const expected = create({
      sessionRenewalMs: patch.sessionRenewalMs,
      sessionExpirationMs: patch.sessionExpirationMs,
    }).controller.snapshot();
    expect(create(patch).controller.snapshot()).toEqual(expected);
    const { controller } = create(initial);
    expect(await controller.updateCfg(patch)).toEqual({
      revision: 1,
      changedPaths: changedPaths.slice(1),
    });
    expect(controller.snapshot()).toEqual({ ...expected, samplingPercentage: 50 });
    expect(await controller.updateCfg(patch)).toEqual({ revision: 1, changedPaths: [] });
  });

  it.each([
    { session: { inactivityTimeout: 60 }, sessionRenewalMs: 61000 },
    { session: { maxDuration: 120 }, sessionExpirationMs: 121000 },
    { session: { inactivityTimeout: 0 }, sessionRenewalMs: 0 },
    { session: { maxDuration: 0 }, sessionExpirationMs: 0 },
    { session: undefined, sessionRenewalMs: 1000 },
    { session: undefined, sessionExpirationMs: 1000 },
    { session: { inactivityTimeout: undefined }, sessionRenewalMs: 1000 },
    { session: { maxDuration: undefined }, sessionExpirationMs: 1000 },
  ])("rejects conflicting normalized values atomically: %s", async (patch) => {
    expect(() => create(patch)).toThrow("Conflicting configuration paths");
    const { controller } = create(initial);
    const original = controller.snapshot();
    await expect(controller.updateCfg({ ...patch, samplingPercentage: 0 })).rejects.toThrow(
      "Conflicting configuration paths",
    );
    expect(controller.snapshot()).toBe(original);
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  });

  it("allows aliases and native fields in separate updates to replace each other", async () => {
    const { controller } = create(initial);
    expect(
      await controller.updateCfg({ sessionRenewalMs: 1000, sessionExpirationMs: 2000 }),
    ).toEqual({ revision: 1, changedPaths: changedPaths.slice(1) });
    expect(controller.snapshot().session).toEqual({ inactivityTimeout: 1, maxDuration: 2 });
    expect(
      await controller.updateCfg({ session: { inactivityTimeout: 0, maxDuration: 0 } }),
    ).toEqual({ revision: 2, changedPaths: changedPaths.slice(1) });
    expect(controller.snapshot().session).toEqual({ inactivityTimeout: 0, maxDuration: 0 });
  });

  describe.each([
    {
      path: "session.inactivityTimeout",
      patch: (value: unknown) => ({ session: { inactivityTimeout: value } }),
    },
    {
      path: "session.maxDuration",
      patch: (value: unknown) => ({ session: { maxDuration: value } }),
    },
    { path: "sessionRenewalMs", patch: (value: unknown) => ({ sessionRenewalMs: value }) },
    { path: "sessionExpirationMs", patch: (value: unknown) => ({ sessionExpirationMs: value }) },
  ])("$path validation", ({ path, patch }) => {
    it.each([
      NaN,
      Infinity,
      -Infinity,
      -1,
      "60",
      null,
      true,
      {},
      [],
      () => 60,
      new Date(),
      Symbol("duration"),
    ])("rejects invalid durations: %s", async (value) => {
      const update = invalid({ ...patch(value), samplingPercentage: 0 });
      expect(() => create(update)).toThrow(path);
      const { controller } = create(initial);
      const original = controller.snapshot();
      await expect(controller.updateCfg(update)).rejects.toThrow(path);
      expect(controller.snapshot()).toBe(original);
      expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
      expect(await controller.updateCfg({ samplingPercentage: 25 })).toEqual({
        revision: 1,
        changedPaths: ["samplingPercentage"],
      });
    });
  });

  it.each([
    null,
    [],
    () => ({}),
    new Date(),
    1,
    "session",
    true,
    Symbol("session"),
    Object.create({ inactivityTimeout: 60 }),
  ])("rejects non-plain session objects: %s", async (session) => {
    const { controller } = create(initial);
    const original = controller.snapshot();
    await expect(controller.updateCfg(invalid({ samplingPercentage: 0, session }))).rejects.toThrow(
      "plain object",
    );
    expect(controller.snapshot()).toBe(original);
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  });

  it.each([
    { enabled: false },
    { persist: false },
    { storage: { enabled: false } },
    { session: { enabled: false, inactivityTimeout: 30 } },
    { session: { persist: false, maxDuration: 30 } },
    { session: { storage: {} } },
    { session: { sessionRenewalMs: 1000 } },
    { session: { [Symbol("inactivityTimeout")]: 60 } },
    { session: JSON.parse('{"__proto__":{}}') as unknown },
    { session: { constructor: 60 } },
    { session: { prototype: 60 } },
  ])("rejects unsupported properties without partially committing: %s", async (patch) => {
    const { controller } = create(initial);
    const original = controller.snapshot();
    await expect(
      controller.updateCfg(
        invalid({
          samplingPercentage: 0,
          sessionRenewalMs: 1000,
          sessionExpirationMs: 2000,
          ...patch,
        }),
      ),
    ).rejects.toThrow("Unsupported configuration path");
    expect(controller.snapshot()).toBe(original);
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  });

  it.each([
    "session",
    "sessionRenewalMs",
    "sessionExpirationMs",
    "inactivityTimeout",
    "maxDuration",
  ])("rejects the %s accessor without invoking it", async (key) => {
    const getter = vi.fn(() => 60);
    const setter = vi.fn();
    const target = Object.defineProperty({}, key, { get: getter, set: setter });
    const patch =
      key === "inactivityTimeout" || key === "maxDuration"
        ? { samplingPercentage: 0, session: target }
        : Object.defineProperties(
            { samplingPercentage: 0 },
            Object.getOwnPropertyDescriptors(target),
          );
    const { controller } = create(initial);
    const original = controller.snapshot();
    await expect(controller.updateCfg(invalid(patch))).rejects.toThrow("data property");
    expect(getter).not.toHaveBeenCalled();
    expect(setter).not.toHaveBeenCalled();
    expect(controller.snapshot()).toBe(original);
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  });

  it("accepts own non-enumerable and null-prototype session data", async () => {
    const session: object = Object.create(null) as object;
    Object.defineProperty(session, "inactivityTimeout", { value: 0 });
    Object.defineProperty(session, "maxDuration", { value: 2.5 });
    const patch = Object.create(null) as MicrosoftOpenTelemetryBrowserConfigurationUpdate;
    Object.defineProperty(patch, "session", { value: session });
    const { controller } = create();
    expect(await controller.updateCfg(patch)).toEqual({
      revision: 1,
      changedPaths: changedPaths.slice(1),
    });
    expect(controller.snapshot().session).toEqual({ inactivityTimeout: 0, maxDuration: 2.5 });
    expect(Object.isFrozen(controller.snapshot().session)).toBe(true);
  });

  it("captures initial and queued nested patches before callers mutate them", async () => {
    const session = { inactivityTimeout: 60, maxDuration: 120 };
    const { controller } = create({ session });
    const original = controller.snapshot();
    session.inactivityTimeout = 90;
    session.maxDuration = 180;
    expect(original.session).toEqual({ inactivityTimeout: 60, maxDuration: 120 });
    expect(Object.isFrozen(session)).toBe(false);

    const patch = { samplingPercentage: 25, session };
    const queued = controller.updateCfg(patch);
    patch.samplingPercentage = 75;
    session.inactivityTimeout = 0;
    session.maxDuration = 0;
    patch.session = { inactivityTimeout: 1, maxDuration: 2 };
    expect(controller.snapshot()).toBe(original);
    expect(await queued).toEqual({ revision: 1, changedPaths });
    expect(controller.snapshot()).toEqual({
      samplingPercentage: 25,
      session: { inactivityTimeout: 90, maxDuration: 180 },
    });
    expect(original.session).toEqual({ inactivityTimeout: 60, maxDuration: 120 });
    expect(Object.isFrozen(controller.snapshot().session)).toBe(true);

    const aliases = { sessionRenewalMs: 1000, sessionExpirationMs: 2000 };
    const aliasUpdate = controller.updateCfg(aliases);
    aliases.sessionRenewalMs = 9000;
    aliases.sessionExpirationMs = 10000;
    await aliasUpdate;
    expect(controller.snapshot().session).toEqual({ inactivityTimeout: 1, maxDuration: 2 });
  });

  it("serializes mixed updates with native ordered paths and immutable revision snapshots", async () => {
    const { controller } = create();
    const original = controller.snapshot();
    const first = controller.updateCfg({
      sessionExpirationMs: 2000,
      sessionRenewalMs: 1000,
      samplingPercentage: 25,
    });
    const noOp = controller.updateCfg({ session: { maxDuration: 2, inactivityTimeout: 1 } });
    const invalidUpdate = expect(
      controller.updateCfg(invalid({ session: { persist: false } })),
    ).rejects.toThrow("Unsupported configuration path");
    const second = controller.updateCfg({
      session: { maxDuration: 0, inactivityTimeout: 0 },
      samplingPercentage: 0,
    });
    expect(controller.snapshot()).toBe(original);
    const firstResult = await first;
    const firstSnapshot = controller.snapshot();
    expect(firstResult).toEqual({ revision: 1, changedPaths });
    expect(await noOp).toEqual({ revision: 1, changedPaths: [] });
    await invalidUpdate;
    expect(await second).toEqual({ revision: 2, changedPaths });
    expect(firstSnapshot).toEqual({
      samplingPercentage: 25,
      session: { inactivityTimeout: 1, maxDuration: 2 },
    });
    expect(original).toEqual({ samplingPercentage: undefined, session: defaults });
    expect(controller.snapshot()).toEqual({
      samplingPercentage: 0,
      session: { inactivityTimeout: 0, maxDuration: 0 },
    });
    expect(Object.isFrozen(firstSnapshot)).toBe(true);
    expect(Object.isFrozen(firstSnapshot.session)).toBe(true);
    expect(Object.isFrozen(firstResult)).toBe(true);
    expect(Object.isFrozen(firstResult.changedPaths)).toBe(true);
    expect(() => Object.assign(firstSnapshot.session, { inactivityTimeout: 99 })).toThrow(
      TypeError,
    );
    expect(await controller.updateCfg({}, false)).toEqual({ revision: 3, changedPaths });
    expect(controller.snapshot()).toEqual(original);
    const resetSnapshot = controller.snapshot();
    expect(await controller.updateCfg({ session: {} })).toEqual({ revision: 3, changedPaths: [] });
    expect(controller.snapshot()).toBe(resetSnapshot);
    expect(controller.snapshot().session).toBe(resetSnapshot.session);
  });
});
