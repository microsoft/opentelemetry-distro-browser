// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  isValidInstrumentationKey,
  parseConnectionString,
} from "../../../src/exporter/connectionStringParser.js";

const instrumentationKey = "00000000-0000-0000-0000-000000000000";
const publicCloudConnectionString =
  `InstrumentationKey=${instrumentationKey};` +
  "IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/;" +
  "LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;" +
  "ApplicationId=3cd3dd3f-64cc-4d7c-9303-8d69a4bb8558";

describe("Azure Monitor connection string", () => {
  it("uses the public cloud endpoints by default", () => {
    expect(parseConnectionString(`InstrumentationKey=${instrumentationKey}`)).toEqual({
      instrumentationKey,
      ingestionEndpoint: "https://dc.services.visualstudio.com",
      liveEndpoint: "https://rt.services.visualstudio.com",
      aadAudience: undefined,
      applicationId: undefined,
      location: undefined,
    });
  });

  it("parses explicit public cloud endpoints", () => {
    expect(parseConnectionString(publicCloudConnectionString)).toEqual({
      instrumentationKey,
      ingestionEndpoint: "https://eastus-8.in.applicationinsights.azure.com",
      liveEndpoint: "https://eastus.livediagnostics.monitor.azure.com",
      aadAudience: undefined,
      applicationId: "3cd3dd3f-64cc-4d7c-9303-8d69a4bb8558",
      location: undefined,
    });
  });

  it.each([
    {
      suffix: "applicationinsights.azure.us",
      ingestionEndpoint: "https://usgovvirginia.dc.applicationinsights.azure.us",
      liveEndpoint: "https://usgovvirginia.live.applicationinsights.azure.us",
    },
    {
      suffix: "applicationinsights.azure.cn",
      ingestionEndpoint: "https://chinaeast2.dc.applicationinsights.azure.cn",
      liveEndpoint: "https://chinaeast2.live.applicationinsights.azure.cn",
    },
  ])("resolves sovereign cloud endpoints for $suffix", (expected) => {
    const location = expected.suffix.endsWith(".us") ? "usgovvirginia" : "chinaeast2";
    const result = parseConnectionString(
      `InstrumentationKey=${instrumentationKey};EndpointSuffix=${expected.suffix};Location=${location}`,
    );

    expect(result.ingestionEndpoint).toBe(expected.ingestionEndpoint);
    expect(result.liveEndpoint).toBe(expected.liveEndpoint);
  });

  it("prefers explicit endpoints and preserves HTTP(S) protocols", () => {
    const result = parseConnectionString(
      `InstrumentationKey=${instrumentationKey};EndpointSuffix=applicationinsights.azure.us;` +
        "IngestionEndpoint=http://custom.ingest.example/;LiveEndpoint=https://custom.live.example/",
    );

    expect(result.ingestionEndpoint).toBe("http://custom.ingest.example");
    expect(result.liveEndpoint).toBe("https://custom.live.example");
  });

  it("discards unsupported endpoint schemes and uses suffix-derived endpoints", () => {
    const result = parseConnectionString(
      `InstrumentationKey=${instrumentationKey};EndpointSuffix=applicationinsights.azure.us;` +
        "Location=usgovvirginia;IngestionEndpoint=ftp://custom.ingest.example;" +
        "LiveEndpoint=file:///custom/live",
    );

    expect(result.ingestionEndpoint).toBe("https://usgovvirginia.dc.applicationinsights.azure.us");
    expect(result.liveEndpoint).toBe("https://usgovvirginia.live.applicationinsights.azure.us");
  });

  it("discards malformed endpoint overrides independently", () => {
    const result = parseConnectionString(
      `InstrumentationKey=${instrumentationKey};IngestionEndpoint=not-a-url;` +
        "LiveEndpoint=https://custom.live.example/",
    );

    expect(result.ingestionEndpoint).toBe("https://dc.services.visualstudio.com");
    expect(result.liveEndpoint).toBe("https://custom.live.example");
  });

  it("parses supported fields case-insensitively", () => {
    const result = parseConnectionString(
      `instrumentationKEY=${instrumentationKey};ApplicationId=app-id;AadAudience=audience`,
    );

    expect(result.instrumentationKey).toBe(instrumentationKey);
    expect(result.applicationId).toBe("app-id");
    expect(result.aadAudience).toBe("audience");
  });

  it("discards a malformed connection string", () => {
    expect(parseConnectionString(`InstrumentationKey=${instrumentationKey};invalid`)).toEqual({
      ingestionEndpoint: "https://dc.services.visualstudio.com",
      liveEndpoint: "https://rt.services.visualstudio.com",
    });
  });

  it.each([
    [instrumentationKey, true],
    [instrumentationKey.toUpperCase(), true],
    ["not-an-instrumentation-key", false],
  ])("validates instrumentation key %s", (value, expected) => {
    expect(isValidInstrumentationKey(value)).toBe(expected);
  });
});
