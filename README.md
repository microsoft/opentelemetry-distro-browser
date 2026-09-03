# OpenTelemetry Browser Distribution

This repository contains browser-focused OpenTelemetry distribution experiments and supporting
implementation work.

## Multi-instance browser PoC

The [`poc/`](poc/) project investigates a browser-specific OpenTelemetry problem: multiple
independently configured SDK consumers can share one page, but `@opentelemetry/api` permits only one
global tracer provider per JavaScript realm.

The prototype registers one global routing provider and binds each acquired tracer to a specific SDK
instance. Its browser test runs two overlapping consumers and verifies that their application and
upstream instrumentation spans do not cross pipelines.

See the [PoC documentation](poc/README.md) for:

- the decision being tested and current conclusion;
- architecture and instance-routing details;
- async context and instrumentation constraints;
- browser acceptance-test evidence;
- known limitations and next experiments;
- local build and test commands.

The PoC is experimental evidence, not a production-ready SDK or a statement of browser support.

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit
[Contributor License Agreements](https://cla.opensource.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a
CLA and decorate the pull request appropriately. You only need to do this once across repositories
using this CLA.

This project has adopted the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more
information, see the
[Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact
[opencode@microsoft.com](mailto:opencode@microsoft.com).

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of
Microsoft trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion
or imply Microsoft sponsorship. Any use of third-party trademarks or logos is subject to those third
parties' policies.
