// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { validateSamplingPercentage } from "../sampling.js";

/**
 * Supported runtime updates. Undefined restores the default parent-based sampling policy.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserConfigurationUpdate {
  /** Finite percentage from 0 through 100. Omission retains the current value when merging. */
  samplingPercentage?: number;
}

/**
 * Result of a runtime update. No-op updates retain the current revision.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserConfigurationUpdateResult {
  readonly revision: number;
  readonly changedPaths: readonly string[];
}

/** Captures data before queuing, without invoking application getters. */
function samplingPercentage(patch: MicrosoftOpenTelemetryBrowserConfigurationUpdate): {
  supplied: boolean;
  value: number | undefined;
} {
  if (
    !patch ||
    typeof patch !== "object" ||
    (Object.getPrototypeOf(patch) !== Object.prototype && Object.getPrototypeOf(patch) !== null)
  ) {
    throw new TypeError("Configuration must be a plain object.");
  }
  for (const key of Reflect.ownKeys(patch)) {
    if (key !== "samplingPercentage") {
      throw new TypeError(`Unsupported configuration path: ${String(key)}.`);
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(patch, "samplingPercentage");
  if (descriptor && !("value" in descriptor)) {
    throw new TypeError("samplingPercentage must be a data property.");
  }
  const value: unknown = descriptor?.value;
  if (value !== undefined && typeof value !== "number") {
    throw new TypeError("samplingPercentage must be a number.");
  }
  return {
    supplied: !!descriptor,
    value: value === undefined ? undefined : validateSamplingPercentage(value),
  };
}

/** Sampling-only instance controller; publication has no external lifecycle side effects. */
export function createRuntimeConfiguration(
  initial: MicrosoftOpenTelemetryBrowserConfigurationUpdate,
  isStopped: () => boolean,
) {
  let current = Object.freeze({ samplingPercentage: samplingPercentage(initial).value });
  let revision = 0;
  let queue = Promise.resolve();

  return {
    snapshot: () => current,
    updateCfg(
      patch: MicrosoftOpenTelemetryBrowserConfigurationUpdate,
      mergeExisting = true,
    ): Promise<MicrosoftOpenTelemetryBrowserConfigurationUpdateResult> {
      let update: ReturnType<typeof samplingPercentage>;
      try {
        if (typeof mergeExisting !== "boolean") {
          throw new TypeError("mergeExisting must be a boolean.");
        }
        update = samplingPercentage(patch);
      } catch (error) {
        return Promise.reject(
          error instanceof Error
            ? error
            : new TypeError("Invalid configuration.", { cause: error }),
        );
      }
      const operation = queue.then(() => {
        if (isStopped()) throw new Error("Telemetry instance is stopped.");
        const value = update.supplied || !mergeExisting ? update.value : current.samplingPercentage;
        const changed = value !== current.samplingPercentage;
        if (changed) {
          current = Object.freeze({ samplingPercentage: value });
          revision++;
        }
        return Object.freeze({
          revision,
          changedPaths: Object.freeze(changed ? ["samplingPercentage"] : []),
        });
      });
      // Invalid or stopped updates must not poison later queued work.
      queue = operation.then(
        () => {},
        () => {},
      );
      return operation;
    },
  };
}
