// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { trace, type Context, type ContextManager } from "@opentelemetry/api";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import type { PageViewSource } from "./types.js";

/** Supplies a page operation only when the application's active context has no span. */
export class PageViewContextManager implements ContextManager {
  private enabled = false;

  constructor(
    private getPageView: PageViewSource["getCurrentPageView"] | undefined,
    private readonly delegate: ContextManager = new StackContextManager(),
  ) {}

  active(): Context {
    const active = this.delegate.active();
    const pageView = this.enabled ? this.getPageView?.() : undefined;
    return pageView && !trace.getSpan(active)
      ? trace.setSpanContext(active, pageView.spanContext)
      : active;
  }

  with: ContextManager["with"] = (context, callback, thisArg, ...args) =>
    this.delegate.with(context, callback, thisArg, ...args);

  bind: ContextManager["bind"] = (context, target) => this.delegate.bind(context, target);

  enable(): this {
    this.delegate.enable();
    this.enabled = true;
    return this;
  }

  disable(): this {
    this.enabled = false;
    this.delegate.disable();
    return this;
  }

  /** Releases the owned page source without unregistering the application's context manager. */
  shutdown(): void {
    this.getPageView = undefined;
  }
}
