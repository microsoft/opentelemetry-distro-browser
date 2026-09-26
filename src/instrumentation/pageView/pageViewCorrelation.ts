// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { trace, type ContextManager, type SpanContext } from "@opentelemetry/api";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";

/** Uses the page operation only when telemetry has no application-supplied span context. */
export class PageViewCorrelation implements ContextManager, LogRecordProcessor {
  private running = false;

  constructor(
    private getOperation: (() => SpanContext | undefined) | undefined,
    private readonly delegate: ContextManager = new StackContextManager(),
  ) {}

  active(): ReturnType<ContextManager["active"]> {
    const active = this.delegate.active();
    const operation = this.running ? this.getOperation?.() : undefined;
    return operation && !trace.getSpan(active) ? trace.setSpanContext(active, operation) : active;
  }

  with: ContextManager["with"] = (ctx, fn, thisArg, ...args) =>
    this.delegate.with(ctx, fn, thisArg, ...args);

  bind: ContextManager["bind"] = (ctx, target) => this.delegate.bind(ctx, target);

  enable(): this {
    this.delegate.enable();
    this.running = true;
    return this;
  }

  disable(): this {
    this.running = false;
    this.delegate.disable();
    return this;
  }

  // Correlation must not enable records rejected by the application's log processors.
  enabled(): boolean {
    return false;
  }

  onEmit(record: ReadWriteLogRecord): void {
    const operation = !record.spanContext && this.getOperation?.();
    if (operation) record.spanContext = operation;
  }

  async forceFlush(): Promise<void> {}

  shutdown(): Promise<void> {
    this.getOperation = undefined;
    return Promise.resolve();
  }
}
