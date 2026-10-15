# TopoTopo brand files

- `mark.svg`: the mark, three stepped isometric terraces (terrain, quantised and built up); 256 × 256 viewBox,
  the mark spans the middle 65 %. Palette `#f4a26c` (top faces), `#d9622b` (left), `#a8461a` (right); text
  `#f3efe9` on `#17191d`. Generated from computed coordinates, so the edges meet exactly.
- `mark-1024.png`: the same on a transparent background.
- `channel-1024.png`: dark background, padded for a circular crop (YouTube, GitHub org, npm).
- `banner-2560x1440.png`: YouTube channel banner; the lockup sits inside the 1546 × 423 safe area.

The site favicon is written from `mark.svg` by `scripts/gen-site.ts` (cropped to the mark's bounds). The README
header uses `mark.svg` directly. Chosen on 2026-10-15 from five candidates; the earlier favicon was a plain cube.
