# Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant
Microsoft the rights to use your contribution. For details, visit
[Contributor License Agreements](https://cla.opensource.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a
CLA and decorate the pull request appropriately. Follow the instructions provided by the bot. You
only need to do this once across repositories using Microsoft's CLA process.

This project has adopted the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more
information, see the
[Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact
[opencode@microsoft.com](mailto:opencode@microsoft.com) with questions or concerns.

## Before You Start

- Search existing issues before opening a new one.
- Open an issue before starting large changes so the scope and direction can be discussed.
- Keep changes focused and include tests when behavior changes.

## Development Setup

1. Install a [Node.js](https://nodejs.org/) version supported by `package.json`.
2. Install dependencies and Chromium.
3. Run the repository checks before opening a pull request.

```powershell
npm ci
npm run test:install-browsers
npm run check
```

Microsoft contributors must use the required Microsoft package proxy. The committed lockfile omits
registry URLs so external contributors can install the same dependency versions from an accessible
npm registry.

## Pull Requests

- Describe the problem and the approach clearly.
- Link related issues when applicable.
- Update documentation when public behavior or setup changes.
- Keep the repository planning, API reports, and README documents aligned with the implementation.
