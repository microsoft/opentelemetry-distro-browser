// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { getOperationNames, getSharedRegistry } from "../shared/globalOwnership.js";

/** Snapshots managed page context without adding vendor attributes to OpenTelemetry records. */
export function setManagedOperationName(record: object, name: string | undefined): void {
  const registry = getSharedRegistry();
  if (name) (registry.operationNames ??= new WeakMap()).set(record, name);
  else registry.operationNames?.delete(record);
}

/** Reads page context captured when the record entered its provider pipeline. */
export function getManagedOperationName(record: object): string | undefined {
  return getOperationNames()?.get(record);
}
