// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createContext, useContext } from "react";
import type { ReactPlugin } from "./ReactPlugin.js";

/**
 * Supplies the initialized, instance-bound plugin to React descendants. There is no global fallback.
 * @public
 */
export const AppInsightsContext = /* @__PURE__ */ createContext<ReactPlugin | undefined>(undefined);

/**
 * Reads the nearest React telemetry provider.
 * @throws An Error when no plugin is supplied by an `AppInsightsContext` provider.
 * @public
 */
export function useAppInsightsContext(): ReactPlugin {
  const plugin = useContext(AppInsightsContext);
  if (!plugin) {
    throw new Error("useAppInsightsContext requires an AppInsightsContext provider.");
  }
  return plugin;
}
