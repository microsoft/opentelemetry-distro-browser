// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Builder } from "selenium-webdriver";
import packageJson from "../../package.json" with { type: "json" };

const browserConfigurations = {
  Chrome: { browserName: "Chrome", os: "Windows", osVersion: "10" },
  Edge: { browserName: "Edge", os: "Windows", osVersion: "10" },
  Firefox: { browserName: "Firefox", os: "Windows", osVersion: "10" },
  Safari: { browserName: "Safari", os: "OS X", osVersion: "Monterey" },
};

function supportMatrix() {
  return packageJson.browserslist.map((entry) => {
    const match = /^(Chrome|Edge|Firefox|Safari) >= ([\d.]+)$/.exec(entry);
    assert.ok(match, `Unsupported browserslist entry: ${entry}`);
    return { family: match[1], version: match[2] };
  });
}

test("browserslist declares each supported browser family once", () => {
  assert.deepEqual(
    supportMatrix().map(({ family }) => family),
    Object.keys(browserConfigurations),
  );
});

const requestedFamily = process.env.BROWSER_FAMILY;
if (requestedFamily) {
  test(`loads the published bundle in the minimum supported ${requestedFamily}`, async (context) => {
    const supportedBrowser = supportMatrix().find(({ family }) => family === requestedFamily);
    assert.ok(supportedBrowser, `Unknown BROWSER_FAMILY: ${requestedFamily}`);

    const userName = process.env.BROWSERSTACK_USERNAME;
    const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;
    assert.ok(userName, "BROWSERSTACK_USERNAME is required");
    assert.ok(accessKey, "BROWSERSTACK_ACCESS_KEY is required");

    const configuration = browserConfigurations[supportedBrowser.family];
    const driver = await new Builder()
      .usingServer("https://hub-cloud.browserstack.com/wd/hub")
      .withCapabilities({
        browserName: configuration.browserName,
        browserVersion: supportedBrowser.version,
        "bstack:options": {
          os: configuration.os,
          osVersion: configuration.osVersion,
          userName,
          accessKey,
          projectName: "opentelemetry-distro-browser",
          buildName: process.env.GITHUB_RUN_ID ?? "local",
          sessionName: `${supportedBrowser.family} ${supportedBrowser.version} support`,
        },
      })
      .build();

    let passed = false;
    try {
      await driver.get("about:blank");
      const source = await readFile(
        new URL("../../dist/browser/opentelemetry-browser.iife.min.js", import.meta.url),
        "utf8",
      );
      await driver.executeScript(
        "const script = document.createElement('script'); script.textContent = arguments[0]; document.head.appendChild(script);",
        source,
      );

      const version = await driver.executeScript(
        "return window.Microsoft?.OpenTelemetry?.OPENTELEMETRY_BROWSER_VERSION;",
      );
      assert.equal(version, packageJson.version);
      passed = true;
    } finally {
      await driver
        .executeScript(
          `browserstack_executor: {"action":"setSessionStatus","arguments":{"status":"${passed ? "passed" : "failed"}","reason":"Browser support acceptance test"}}`,
        )
        .catch((error) => context.diagnostic(`Could not set BrowserStack status: ${error}`));
      await driver.quit();
    }
  });
}
