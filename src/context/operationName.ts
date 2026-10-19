// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { getOperationName, getSharedRegistry } from "../shared/globalOwnership.js";

export interface ManagedOperationNameSnapshot {
  name: string | undefined;
  settled?: boolean;
}

/** Snapshots managed page context without adding vendor attributes to OpenTelemetry records. */
export function setManagedOperationName(
  record: object,
  name: string | ManagedOperationNameSnapshot | undefined,
): void {
  const registry = getSharedRegistry();
  if (typeof name === "object") {
    (registry.operationNameSnapshots ??= new WeakMap()).set(record, name);
  } else if (name) {
    (registry.operationNames ??= new WeakMap()).set(record, name);
    registry.operationNameSnapshots?.delete(record);
  } else {
    registry.operationNames?.delete(record);
    registry.operationNameSnapshots?.delete(record);
  }
}

/** Preserves the mutable snapshot when a processor derives another record object. */
export function copyManagedOperationName(source: object, target: object): void {
  setManagedOperationName(target, getOperationName(source));
}

/** Reads page context captured when the record entered its provider pipeline. */
export function getManagedOperationName(record: object): string | undefined {
  const name = getOperationName(record);
  return typeof name === "object" ? name.name : name;
}
