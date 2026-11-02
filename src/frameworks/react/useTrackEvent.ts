// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ReactPlugin } from "./ReactPlugin.js";

/** A React state setter that drives committed custom-event telemetry. @public */
export type AIReactCustomEvent<T> = Dispatch<SetStateAction<T>>;

/**
 * Returns a state setter that tracks the event data on committed updates.
 *
 * @remarks
 * `eventData` initializes React state; later changes to that argument do not replace state.
 * Functional setters and React's same-value update suppression work as with `useState`.
 * By default the initial event is skipped; set `skipFirstRun` to false to report it. Changes
 * to the plugin or event name also report the current state. StrictMode effect replay does
 * not report the same committed event twice. Object data supplies custom properties;
 * scalar data is recorded as a `data` property. Effects do not run during server rendering.
 * @public
 */
export function useTrackEvent<T>(
  reactPlugin: ReactPlugin,
  eventName: string,
  eventData: T,
  skipFirstRun = true,
): AIReactCustomEvent<T> {
  const [data, setData] = useState<T>(eventData);
  const previous = useRef<{ plugin: ReactPlugin; name: string; data: T } | undefined>(undefined);

  useEffect(() => {
    const last = previous.current;
    if (last?.plugin === reactPlugin && last.name === eventName && Object.is(last.data, data)) {
      return;
    }
    previous.current = { plugin: reactPlugin, name: eventName, data };
    if (!last && skipFirstRun) return;

    const properties =
      typeof data === "object" && data !== null
        ? Object.fromEntries(Object.entries(data))
        : { data };
    reactPlugin.trackEvent({ name: eventName }, properties);
  }, [reactPlugin, eventName, data, skipFirstRun]);

  return setData;
}
