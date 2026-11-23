# MedOS Reference Sidebar

Build-free Chrome MV3 extension for MedOS reference boxes.

## What's new in v2.0

- **In-panel Dose Calculator / prescription builder.** Opening a drug in the
  side panel now shows the same prescribing tool as the app's Drug Reference:
  indication picker, weight/age, dose form, **CrCl** and **Child-Pugh** inputs.
  Results include the parsed dose, the renal & hepatic guidance boxes (AVOID /
  NO CHANGE / DOSE ADJUSTED / VERIFY chips with the source text), cross-
  indication fallback notices, and — when the rule is prescription-ready — a
  formatted **Rx block (drug + sig + dispense) with a Copy button** for use on
  hospital computers.
- Backed by the upgraded `/drugs/dose` engine (cross-indication fallback,
  CrCl-bracket renal guidance, Child-Pugh text parsing, infusion-rate mis-parse
  guard, 30-day maintenance supply for chronic regimens).

## What's new in v1.9

- **Hover cards now match the in-app engine** (`AmbossHtml.tsx`). The on-page
  underline tooltip was a simpler bespoke card; it's now a faithful port of the
  app's hover box:
  - 1px source-coloured underlines with the app's exact palette and tinted
    hover backgrounds (was a heavier 2px line).
  - Frosted card with a coloured **brand header**, title, ICD-10 chips,
    abbreviation expansions, abstract, structured **drug card**, and inline HTML
    **tables** — the same rich content the app shows.
  - **Media thumbnails** (up to 3), fetched through the service worker as `data:`
    URLs; clicking one opens a full-size **in-page lightbox**.
  - **Colour-coded source action chips** (Rx / FA / UT / UW / UL / CC / UM / Dx /
    Bk …) for every other database that mentions the term; the primary source is
    folded into the title like the app. A **Q corner** button appears when a
    UWorld question is linked.
  - **Smart sizing & placement** — compact / article / media / exhibit layouts
    and above/below, left/right flipping, ported from the app's `tooltipMetrics`
    / `tooltipPosition`.
  - Per-term result caching, Esc-to-close, scroll-to-close, and wheel-scroll
    containment inside the card.

## What's new in v1.8

- **Search parity with the main app.** The side panel now surfaces *every* source
  the app's `/search` returns — First Aid, UWorld Library, Books, Diseases, UMLS
  concepts and the UWorld QBank — not just Drug Ref / AMBOSS / UpToDate. Each
  source is capped per group so one high-volume source (books) can't crowd the
  others out, and the type-ahead suggestions surface the same sources.
- **First Aid opens in-panel.** First Aid hits render the pre-cropped high-yield
  snippet image plus its extracted text, with an "Open the page in MedOS" button —
  no more silently missing FA results.
- **UWorld Library opens in-panel.** Library articles decrypt and render in the
  reader frame instead of being dropped.
- **Images, Tables & Diagrams wall (Img tab).** When a term resolves to a UMLS
  concept, the Img tab now shows the concept's full media wall — clinical-consult
  diagrams, UpToDate graphics, UWorld-library/AMBOSS figures and UWorld exhibit
  tables — pulled from `/umls/concept/{cui}/media`, mirroring the app's concept
  page. Clicking a tile previews just that single image or table; it never opens a
  whole book/article. UMLS concept results from search open straight into this
  wall.

## What's new in v1.7

- **Killed the per-page "wants to access devices on your local network" prompt.**
  The content script used to `fetch()` the local backend directly from each web
  page's context. Since Chrome 138 that counts as the *page* reaching into the
  local network, so Chrome asked for permission on every site — and even when
  allowed, the backend's localhost-only CORS policy rejected the response, which
  is why underlines and hover cards never appeared on ordinary websites.
- All backend traffic (scan, tooltip, tooltip thumbnails) is now proxied through
  the extension service worker, which talks to `127.0.0.1:8002` under the
  extension's own host permission: no permission prompt, no CORS failure.
  Tooltip images are delivered to the page as `data:` URLs for the same reason.
- Dropped the unnecessary `<all_urls>` **host permission** (content-script
  injection is unchanged); the extension now only requests host access to the
  local MedOS backend/frontend.

## What's new in v1.6

- Brought source coverage in line with the main app. The hover cards, underline
  colors, side-panel badges, and labels now recognize **First Aid, UMLS, Books,
  Diseases, and the UWorld Library** — previously these came back from the backend
  but rendered as a generic, colorless "Reference" entry because `normalizeSource`
  collapsed every unknown source. New source colors match the app (First Aid red,
  UMLS teal).

## What v1.6 does

- Scans ordinary web pages with the local MedOS `/reference/scan` endpoint.
- Adds one-line source-colored underlines:
  - Gray: Drug Reference
  - Blue: AMBOSS
  - Yellow: UWorld/QBank
  - Green: UpToDate
  - Orange: Clinic Consult algorithms/images
  - Red: First Aid
  - Teal: UMLS
  - Gold: UWorld Library
  - Brown: Books
  - Rose: Diseases
- Prioritizes Drug Reference when a generic or brand medication name exists in `drug_reference.sqlite`.
- Opens Chrome's side panel when an underlined term is clicked.
- Shows a compact hover reference card over underlined terms.
- Clicking the hover card or an underlined term opens the side panel and loads the selected concept.
- Selecting text on the current page auto-fills the side-panel search box when the panel is open, and is remembered for the next panel open.
- Uses `/reference/tooltip` to show connected Drug Reference, AMBOSS, UTD, UWorld/QBank, Clinic Consult, First Aid, UMLS, Books, Diseases, UWorld Library, image/table, and algorithm entries.
- Uses a sidebar-native layout rather than embedding whole MedOS app pages:
  - one search box
  - left mode rail: Ref, Q, Img, Calc, DB
  - compact source cards
  - boxed article/table previews
  - inline image previews
  - in-panel QBank question solving
  - native sidebar calculators for common scores/tools, including NIHSS, GCS, eGFR, MELD, CURB-65, SOFA, APGAR, NEWS2, and APACHE II
- Search suggestions are fed by AMBOSS, UpToDate, calculator, and Lexi calculator indexes.
- The single search combines:
  - central connected references,
  - AMBOSS article search,
  - UpToDate topic search,
  - Drug Reference search,
  - MedOS calculator search,
  - suggested UWorld/QBank questions.
- Renders source content in the panel when possible:
  - Drug Reference medication profile with class, indications, dose/frequency, and black-box warning
  - AMBOSS article HTML
  - UpToDate topic HTML
  - Clinic Consult disease/algorithm HTML
  - QBank exhibits/media
  - QBank question JSON as an in-panel question view with answer reveal

UpToDate, AMBOSS, QBank exhibits, and Clinic Consult HTML is fetched from the backend and rendered into an isolated responsive reader iframe. This avoids the narrow Chrome side panel clipping wide source layouts and gives wide tables/images a usable in-panel scroll path.

## Local requirements

Start MedOS first. The extension expects:

```text
Backend:  http://127.0.0.1:8002
Frontend: http://127.0.0.1:3000
```

The frontend is only used as a fallback. The main v1 path is direct API calls to the backend.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder:

```text
D:\MedOS\app\chrome-extension\medos-reference-sidebar
```

## Notes

- The content script skips MedOS app pages to avoid double-underlining the existing in-app renderer.
- The scan is debounced after DOM changes so delayed page content is rechecked automatically.
- Packaging with a native host can be added later so the extension can start/attach to the MedOS backend automatically.
