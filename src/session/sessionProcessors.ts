// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  SessionLogRecordProcessor as UpstreamSessionLogRecordProcessor,
  SessionSpanProcessor as UpstreamSessionSpanProcessor,
} from "@opentelemetry/browser-sdk/session";

// Upstream processors overwrite session.id; the distro only supplies missing IDs.
export class SessionSpanProcessor extends UpstreamSessionSpanProcessor {
  override onStart(...args: Parameters<UpstreamSessionSpanProcessor["onStart"]>): void {
    if (args[0].attributes["session.id"] === undefined) super.onStart(...args);
  }
}

export class SessionLogRecordProcessor extends UpstreamSessionLogRecordProcessor {
  override onEmit(...args: Parameters<UpstreamSessionLogRecordProcessor["onEmit"]>): void {
    if (args[0].attributes["session.id"] === undefined) super.onEmit(...args);
  }
}
