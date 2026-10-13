// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const operationNames = new WeakMap<object, string>();

/** Snapshots managed page context without adding vendor attributes to OpenTelemetry records. */
export function setManagedOperationName(record: object, name: string | undefined): void {
  if (name) operationNames.set(record, name);
  else operationNames.delete(record);
}

/** Reads page context captured when the record entered its provider pipeline. */
export function getManagedOperationName(record: object): string | undefined {
  return operationNames.get(record);
}
