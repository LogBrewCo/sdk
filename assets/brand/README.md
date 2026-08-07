# LogBrew Brand Assets

Canonical LogBrew logo assets for repository, package registry, store, and
in-product use.

`logbrew-logo-espresso-bg-1600.svg` is the one editable logo source. Every
plain transparent, app-icon, store, and raster size is generated from it. The
SDK social preview is a guarded composition that embeds the same approved mug;
it is not another editable logo source.

## Files

- `logbrew-logo-espresso-bg-1600.svg`: canonical true-vector source on espresso.
- `logbrew-logo-espresso-bg-1600.png`: generated full-size app presentation.
- `logbrew-logo-espresso-bg-512.svg` and `.png`: generated package/store logo.
- `logbrew-logo-espresso-bg-128.png`: small square package icon.
- `logbrew-logo-transparent-1600.svg` and `.png`: master transparent logo for in-product UI.
- `logbrew-logo-transparent-512.svg` and `.png`: transparent logo for website/app UI.
- `logbrew-logo-transparent-128.png`: NuGet/package icon source.
- `app-icon-256.png`: compact launcher and installer icon source.
- `app-store-icon-1024.png`: Apple App Store source icon.
- `google-play-icon-512.png`: Google Play listing icon.
- `github-social-preview.png`: GitHub repository social preview image.

## Asset maintenance

Install `rsvg-convert` from `librsvg`, then run:

```bash
python3 scripts/generate_brand_assets.py --write
python3 scripts/generate_brand_assets.py --check
python3 scripts/check_brand_assets.py
```

The manifest records every approved output, its dimensions, alpha contract,
digest, and known superseded hashes. CI regenerates the plain variants and
rejects unexpected, missing, stale, or geometrically different artwork.

## Usage

- Use espresso-background assets for package registries, store listings, app icons, favicons, and social cards.
- Use transparent assets inside website and app UI when the surrounding surface should remain visible.
- Do not recolor, add outlines, add shadows, crop differently, or change the pixel geometry.

## Palette

- Espresso background: `#3C2B24`
- Beer gold: `#FFC61A`
- Edge black: `#111011`
- Foam white: `#FFFFFF`
