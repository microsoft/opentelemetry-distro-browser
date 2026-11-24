// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, SeverityNumber, type Context } from "@opentelemetry/api";
import { ErrorsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/errors";
import { SKIP_PAGE_FALLBACK } from "../../shared/pageOperationContext.js";
import type { InstrumentationOptions } from "../../types.js";
import { getInstrumentations as create } from "./getInstrumentations.js";
import { adaptNativeInstrumentation } from "./nativeInstrumentation.js";

type Snapshot = [timestamp: number, name?: string, message?: string, stack?: string, ctx?: Context];

/** The combined CDN SDK takes over the loader's queue once, when live collection starts. */
export async function getInstrumentations(
  options?: InstrumentationOptions,
  onErrorsEnabled?: (emit: (snapshot: Snapshot, samePage?: boolean) => void) => void,
) {
  if (!onErrorsEnabled || options?.errors?.enabled !== true) return create(options);

  class LoaderErrors extends ErrorsInstrumentation {
    override enable(deps?: Parameters<ErrorsInstrumentation["enable"]>[0]): void {
      super.enable(deps);
      if (!this.isEnabled()) return;
      onErrorsEnabled?.(([timestamp, name, message, stack, ctx = ROOT_CONTEXT], samePage) => {
        this.logger.emit({
          timestamp,
          context: samePage ? ctx : ctx.setValue(SKIP_PAGE_FALLBACK, true),
          eventName: "exception",
          severityNumber: SeverityNumber.ERROR,
          attributes: {
            "exception.type": name,
            "exception.message": message,
            "exception.stacktrace": stack,
          },
        });
      });
      onErrorsEnabled = undefined;
    }
  }
  const { errors, ...others } = options;
  const { enabled: _enabled, ...config } = errors;
  return [...(await create(others)), adaptNativeInstrumentation(new LoaderErrors(config))];
}
