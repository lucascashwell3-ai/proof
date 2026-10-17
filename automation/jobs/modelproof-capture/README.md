# Modelproof capture

Keeps the picture in the home page's Modelproof window true to the live Modelproof home
(https://lucascashwell3-ai.github.io/modelproof/). The picture shows a board of roles and the model each one gets;
those models change as Modelproof's data updates, and a still goes out of date with them.

- **Runs:** GitHub Actions, `.github/workflows/modelproof-capture.yml`, daily 08:20 UTC (after Modelproof's morning
  data jobs). Also by hand (`dry_run`, `force`), and once as a dry run on any pull request that changes the job.
- **Code:** `scripts/capture-modelproof.mjs`. Self-test on frozen inputs: `node scripts/capture-modelproof.mjs --self-test`.

## What one run does
1. **Self-test** on `scripts/checks/fixtures/modelproof-home.html`, a frozen copy of the page's taps and board: the
   reader, the board checks, the change check and the picture checks, including ten planted failures that must be caught.
   It never reads the live page.
2. **Read the board** from the live home: the tap picked in each of the three groups, and the model on each role.
   It must read as 3 picked taps and at least 3 roles, a lead among them, each with a model; anything else fails the run.
3. **Same board as `data/modelproof-capture.json`:** stop. Nothing is written or committed (a re-run is harmless).
4. **Changed board:** capture four pictures (desktop 840 and 1680 px wide, phone 716 and 1074 px), and check each one:
   exact size, 8 to 600 KB, not blank, and dark (the window's backing is the page's own dark). Only when every check
   passes are the pictures and the record written.
5. **Publish:** commit the four pictures and the record straight to `main`, ask Pages to build, then wait until the
   live site serves the new picture (up to 15 minutes).

## What it writes
Only data: `assets/img/modelproof-board.webp`, `-1x`, `-phone`, `-phone-3x`, and `data/modelproof-capture.json`
(the board, the source, when it was captured, and each picture's sha256). Never page code; the alt text in
`index.html` describes the board without model names, so it does not go out of date.

## When it fails
The run goes red and GitHub sends its failed-run email. Nothing half-done reaches the site: every check runs before
the first file is written, and if the deploy never shows up, the site keeps serving the previous picture.
- *the Modelproof home no longer reads as expected*: Modelproof's page changed shape. Look at it, update the reader
  and the fixture together.
- *a picture failed its checks*: the capture came out wrong (blank, light, wrong size). Run with `dry_run` and look at
  the pictures it keeps as an artifact.
- *not live*: the commit is on `main` but Pages has not served it in 15 minutes. Check the Pages build.

After a Modelproof restyle with the same models, run it by hand with `force`.

## Last known good
`data/modelproof-capture.json` holds the board the current pictures show and when they were taken.
