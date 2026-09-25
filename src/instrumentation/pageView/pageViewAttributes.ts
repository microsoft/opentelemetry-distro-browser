// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Attributes } from "@opentelemetry/api";
import {
  ATTR_PAGE_VIEW_ID,
  ATTR_PAGE_VIEW_INDEX,
  ATTR_PAGE_VIEW_NAME,
  ATTR_PAGE_VIEW_NAME_SOURCE,
  ATTR_PAGE_VIEW_REFERRER,
  ATTR_PAGE_VIEW_SAME_DOCUMENT,
  ATTR_PAGE_VIEW_TYPE,
} from "./semconv.js";
import type { PageView } from "./types.js";

/** Maps a sanitized page snapshot to attributes shared by both signals. */
export function pageViewAttributes(pageView: PageView): Attributes {
  return {
    [ATTR_PAGE_VIEW_ID]: pageView.id,
    [ATTR_PAGE_VIEW_INDEX]: pageView.index,
    [ATTR_PAGE_VIEW_NAME]: pageView.name,
    [ATTR_PAGE_VIEW_NAME_SOURCE]: pageView.nameSource,
    [ATTR_PAGE_VIEW_TYPE]: pageView.navigationType,
    [ATTR_PAGE_VIEW_SAME_DOCUMENT]: pageView.sameDocument,
    ...(pageView.referrer ? { [ATTR_PAGE_VIEW_REFERRER]: pageView.referrer } : {}),
  };
}
