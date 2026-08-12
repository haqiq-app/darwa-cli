# Darwa CLI

## Install

```bash
# macOS
brew install haqiq-app/tap/darwa

# macOS, Linux, or Windows with Node.js 20+
npm install -g https://github.com/haqiq-app/darwa-cli/releases/download/v0.2.0/darwa-cli-0.2.0.tgz
```

Then connect your terminal:

```bash
darwa login
```

Projects organize related services. Services are deployable apps backed by GitHub or a local upload:

```bash
darwa projects create Storefront
darwa github connect
darwa github repos
darwa services create Frontend --repo acme/storefront --project storefront
darwa services list --project storefront

# Or deploy the current directory as Web Hosting
darwa deploy
```

See the complete reference at [darwa.com/docs/cli](https://darwa.com/docs/cli).

Use `DARWA_API_URL=http://localhost:8000/api/v1` while developing locally.
