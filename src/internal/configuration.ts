// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { MicrosoftOpenTelemetryBrowserOptions } from "../types.js";

function validateProcessorList(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new TypeError("Processor lists must be arrays.");
  }
}

export function normalizeConfiguration(options: MicrosoftOpenTelemetryBrowserOptions) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Browser telemetry options must be an object.");
  }

  const supportedOptions = [
    "azureMonitor",
    "otlp",
    "resource",
    "samplingRatio",
    "spanProcessors",
    "logRecordProcessors",
    "propagator",
  ];
  for (const key of Object.keys(options)) {
    if (!supportedOptions.includes(key)) {
      throw new TypeError(`Unsupported browser telemetry option: ${key}`);
    }
  }

  const {
    azureMonitor,
    otlp,
    resource,
    samplingRatio = 1,
    spanProcessors = [],
    logRecordProcessors = [],
    propagator,
  } = options;

  if (azureMonitor !== undefined || otlp !== undefined) {
    throw new Error("Destination presets are not implemented. Supply upstream processors.");
  }
  if (
    typeof samplingRatio !== "number" ||
    !Number.isFinite(samplingRatio) ||
    samplingRatio < 0 ||
    samplingRatio > 1
  ) {
    throw new RangeError("samplingRatio must be a finite number from 0 to 1.");
  }
  validateProcessorList(spanProcessors);
  validateProcessorList(logRecordProcessors);

  return {
    resource,
    samplingRatio,
    spanProcessors,
    logRecordProcessors,
    propagator,
  };
}
