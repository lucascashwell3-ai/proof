# Proof

A hand-built portfolio of shipped products. **[Live site](https://lucascashwell3-ai.github.io/proof/)**

| Product | What it is | Links |
|---|---|---|
| **Skillproof** | A malice-checked catalog of Claude skills, plus a skill that installs the right one into your setup. | [site](https://lucascashwell3-ai.github.io/Skillproof/) · [repo](https://github.com/lucascashwell3-ai/Skillproof) |
| **DATproof** | Corporate Bitcoin purchase data for digital asset treasuries, linked to the filings and rebuilt daily. | [site](https://lucascashwell3-ai.github.io/datproof/) · [repo](https://github.com/lucascashwell3-ai/datproof) |
| **Modelproof** | Which AI model should you actually use? An independent, sourced decision tool. | [site](https://lucascashwell3-ai.github.io/modelproof/) · [repo](https://github.com/lucascashwell3-ai/modelproof) |
| rls-guard | An MCP server that audits your Supabase row-level security and hands you the fix SQL. | [npm](https://www.npmjs.com/package/rls-guard-mcp) |

## Pages

- `index.html`: the home page. A WebGL sky with the word "Welcome", then Skillproof, DATproof and Modelproof,
  each in its own product window with a "How it's built" note, then rls-guard.
- `who/index.html`: who makes these, and where to find him (GitHub, LinkedIn, X, email).

Plain HTML, CSS and JS. No framework, no build step, no runtime dependencies: GitHub Pages serves the repo
root as it is. Fonts are self-hosted in `assets/fonts/`. Every word and number shows with JS off, and the sky
falls back to CSS when WebGL is missing.

## DATproof data

The DATproof window's grid and total come from the CSVs in `data/datproof/`, a snapshot of the purchase
filings in the [DATproof repo](https://github.com/lucascashwell3-ai/datproof) (commit 61678a0, 2026-09-28).
After updating them, rewrite the window in `index.html`:

```bash
node scripts/build-datproof.mjs
```

It replaces what sits between the `datproof:grid` markers. Same CSVs, same bytes.

## Run and check

```bash
npm install                  # dev tools only: Playwright and Lighthouse
npx playwright install chromium
npm run serve                # http://127.0.0.1:8080
npm run verify               # every check
npm run verify -- --quick    # skip Lighthouse and the sunset scan
```

`verify` prints one line per check, PASS, FAIL or SKIP, and exits non-zero on any FAIL. It covers console
errors, phone-width overflow, visibility and paint with reduced motion and with JS off, the DATproof total
against the CSVs, the grid fill, the hero's GPU time and fallbacks, the back/forward cache, every outside link,
and Lighthouse. The link check uses the installed Google Chrome. LinkedIn answers every automated client
with a 999, so that one link prints SKIP and needs a check by hand.
