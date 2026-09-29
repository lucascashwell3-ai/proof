---
name: Proof
colors:
  bg: "oklch(0.978 0.002 255)"
  mat: "oklch(0.948 0.004 255)"
  mat-line: "oklch(0.905 0.005 255)"
  line: "oklch(0.9 0.004 250)"
  line-strong: "oklch(0.84 0.005 250)"
  chrome: "oklch(0.995 0.001 255)"
  ink: "oklch(0.2 0.01 255)"
  ink-2: "oklch(0.41 0.01 255)"
  ink-3: "oklch(0.49 0.01 255)"
  window-black: "#0b0d11"
  field-skillproof: "oklch(0.18 0.022 284)"
  field-datproof: "oklch(0.175 0.024 162)"
typography:
  display:
    fontFamily: Schibsted Grotesk
    fontWeight: 500
    letterSpacing: -0.035em
  body:
    fontFamily: Schibsted Grotesk
    fontSize: 16px
    lineHeight: 1.55
  mono:
    fontFamily: Fragment Mono
    fontSize: 13px
rounded:
  window: 10px
  mat: 20px
  pill: 999px
spacing:
  gutter: "clamp(16px, 4vw, 48px)"
  section-gap: "clamp(24px, 5.5vh, 48px)"
  caption-width: 330px
---

# Proof — design system

## Overview
A quiet light page that works like a gallery wall. Each product hangs in one dark window on its own
tinted, grained field, lit from behind. The page itself stays near-white and nearly silent so the
products carry all the colour. The only spectacle is the hero, "First Light": a WebGL dawn above a
sea of clouds that scrolls from night into day, and the day becomes the page.

Light mode only. The dark windows need the light ground to read as objects.

## Colors
- Ground `bg`, a true off-white (chroma 0.002 toward 255, not warm). `mat` and `mat-line` are one
  step darker for inset panels. `chrome` is the white title bar of every window.
- Ink ramp: `ink` for headings and body, `ink-2` for captions (≥ 7:1 on bg), `ink-3` for metadata
  (≥ 4.5:1 on bg). Never lighter than `ink-3` for text.
- One shared window black (`#0b0d11`) so every product window reads as one family.
- Each product gets its own field: a radial light (L 0.36) fading into a deep tinted ground
  (L 0.17–0.18), overlaid with a 160px fractal-noise grain at 0.42 opacity. Hue comes from the
  product: DATproof green (162), Skillproof violet (284), Modelproof its own hue. Fields are the only
  saturated colour below the hero.

## Typography
- Schibsted Grotesk (variable, one file) for everything readable. Fragment Mono (one file) for spec
  lines, numbers in product windows, and the footer measurement.
- Display: `clamp()` up to ~4.25rem, weight 500, tracking −0.035em, `text-wrap: balance`.
- Section titles: clamp(1.6rem → 2.1rem), tracking −0.025em. Captions 17px / 1.5 in `ink-2`.
- Self-hosted, subset woff2, preloaded, `font-display: swap`, with metric-matched fallbacks.

## Layout
- Content max 1360px, fluid gutter. Each project = caption column (330px) + framed window on its
  mat. Below 1024px the caption stacks above the window: title and Visit on one row, the line below.
- Generous, varied rhythm: 96px between framed windows on desktop, 48px on phones.
- No cards for content. The window + mat is the one framing device.

## Elevation & Depth
- Windows: 1px near-black ring, a small contact shadow, and one long soft drop shadow. On hover a
  second shadow fades in and the window lifts 3px.
- Nothing else on the page casts a shadow.

## Components
- **Window chrome:** 34px white title bar, three grey dots (traffic-light colours on hover),
  centred title in `ink-3`. Body is the product itself, on the shared black.
- **Buttons:** one family. Filled ink pill = primary (Visit). Outline pill = secondary. 40px tall,
  16px filled icon (Phosphor Fill, one ink) where the icon carries meaning.
- **How it's built:** a disclosure under each caption. The panel opens with a grid-rows spring;
  `aria-expanded` on the button; content is in the DOM and readable without script.
- **Nav:** appears after the hero. Wordmark + Skillproof · DATproof · Modelproof · Who am I, with a
  2px ink indicator that springs to the active chapter.
- **Focus:** a 2px ink ring offset 4px that springs in. Never removed.

## Motion
One named motion per element, transform and opacity only:
- Hero: the one peak (scroll = night to day, cursor moves the sun).
- Nav indicator: spring slide. Buttons and links: spring lift and press (CSS `linear()` spring,
  ease-out fallback).
- DATproof grid: fills once when it enters view (real data filling in).
- How it's built: spring open.
- Everything else is still. Reduced motion: no travel, fades allowed, every element visible at rest.

## Do's and Don'ts
- Do show the real product in every window, from real captures or faithful rebuilds of real data.
- Do keep one receipt per project at most, and only a traceable time or cost saving.
- Don't use tag rows, stat bentos, numbered counters, eyebrows over every section, emoji, gradient
  text, side-stripe borders, typing effects, cursor followers or scroll-jacking.
- Don't use Inter, Space Grotesk, Geist or Fraunces.
