<div align="center">

# AERO-VIEW

### 3D ULPIN Vertical Property Mapper

**Next.js 15 · React 19 · Cesium 1.126 · PostGIS 16 + SFCGAL · Electron 44**

![Next.js 15](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-20232A?logo=react&logoColor=61DAFB)
![Cesium 1.126](https://img.shields.io/badge/Cesium-1.126-6CADDF?logo=cesium&logoColor=white)
![PostGIS 16 + SFCGAL](https://img.shields.io/badge/PostGIS-16%20%2B%20SFCGAL-4479A1?logo=postgis&logoColor=white)
![Electron 44](https://img.shields.io/badge/Electron-44-2B2E3A?logo=electron&logoColor=9FEAF9)
![Web + Windows desktop](https://img.shields.io/badge/Platform-web%20%2B%20Windows%20desktop-0078D4?logo=windows&logoColor=white)

<img src="docs/shots/1-city.png" width="920" alt="AERO-VIEW — Siripuram, Visakhapatnam, rendered in Cesium"/>

</div>

A three-dimensional cadastral viewer that models the whole vertical stack of
property — **parcel → building → floor → unit** — plus the **underground
utility corridors** that can encroach on a basement, the **Section 22A
restricted-lands register**, and an **ISO 19152 (LADM)** rights layer. It runs
as a web app *and* as a packaged Windows desktop application.

Every entity on screen carries a **provenance badge**: real, estimated,
derived, synthetic or placeholder. In an area where fewer than one in ten
buildings has a storey count in OpenStreetMap, a viewer must never leave you
guessing which numbers were measured and which were inferred.

---

## Demo video

https://www.youtube.com/watch?v=F7hnRkYftOg

<details>
<summary>Player not showing? Click the thumbnail to watch on YouTube.</summary>

[![AERO-VIEW demo on YouTube](https://img.youtube.com/vi/F7hnRkYftOg/hqdefault.jpg)](https://www.youtube.com/watch?v=F7hnRkYftOg)

</details>

---

## Highlights

- **Full vertical cadastre** — drill city → building → floor → unit, each
  level picked through the one above it, basements lifted into the light.
- **Real 3D conflict detection** — underground utilities intersect-tested
  against basement solids (`ST_3DIntersects`), violations pulsing red.
- **Honest by construction** — a provenance badge on every entity, and a
  data table that says exactly what is real, estimated, derived or synthetic.
- **ISO 19152 (LADM)** — parties, rights and the plot beneath your flat,
  answered as one legal record.
- **Web and Windows desktop** — installer + portable exe, the cadastre works
  fully offline.

---

## Screenshots

| | | |
|---|---|---|
| <img src="docs/shots/3-explode.png" width="330" alt="Explode view"/> | <img src="docs/shots/6-underground.png" width="330" alt="Underground utilities"/> | <img src="docs/shots/12-floor-units.png" width="330" alt="Floor with units"/> |
| **Explode** — the stack, separated | **Underground** — conflicts pulse red | **Floor** — every unit co-pickable |
| <img src="docs/shots/7-provenance-legend.png" width="330" alt="Provenance legend"/> | <img src="docs/shots/vizag-station.png" width="330" alt="Vizag railway station"/> | <img src="docs/shots/13-floor-sliced.png" width="330" alt="Sliced floor"/> |
| **Provenance** — badge + legend | **Infrastructure** — station & air-rights | **Slice** — drag-plane section cut |

---

## Contents

- [The projects](#the-projects)
- [The identifier](#the-identifier)
- [What is real and what is not](#what-is-real-and-what-is-not)
- [Viewer features](#viewer-features)
- [Windows desktop app](#windows-desktop-app)
- [Running the web app](#running-the-web-app)
- [API](#api)
- [Architecture](#architecture)
- [Verification](#verification)
- [Known limitations](#known-limitations)
- [Data sources and licences](#data-sources-and-licences)
- [Repository map](#repository-map)

---

## The projects

One project is one area of interest. `/` is the gallery; each viewer opens at
`/p/<slug>`. Three ship in the repository:

| Project | Area | Prefix | Buildings | Floors | Units | Parcels | Streets | Utilities | Conflicts |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| `siripuram` | Siripuram, Visakhapatnam | `AP-VSP-3D26` | 385 | 1,834 | 6,636 | 326 | 131 | 304 | 0 |
| `hyderabad-banjara` | Banjara Hills Ward, Hyderabad | `TS-HYD-3D26` | 2,213 | 8,119 | 31,807 | 1,309 | 350 | 1,214 | 80 |
| `vizag-infra` | Visakhapatnam Central Corridor | `AP-VSP-3D26` | 2 | — | — | 2 | 2 | 15 | 0 |

`siripuram` is the primary demo: real CartoDEM ground elevation (19.6–82.6 m
MSL) and the ISRO Bhuvan context overlays. `hyderabad-banjara` was generated
from the same pipeline to prove nothing is hardcoded — and it is where the 3D
conflict check has real work to do (80 flagged utility/basement encroachments).
`vizag-infra` is an infrastructure demonstration: a railway station and a
flyover, including air-rights volumes, rather than a floor/unit cadastre.

Parcel numbering restarts at 0001 in every project; the state-district prefix
keeps identifiers distinct, exactly as the real ULPIN means it to.

---

## The identifier

```
AP-VSP-3D26-<parcel4>-<bldg3>-<floor2>-<unit2>
        e.g.  AP-VSP-3D26-0042-007-05-03
```

Right-truncated for coarser entities; floor codes are `00` ground, `01`–`99`
above, `B1`–`B9` basements.

> **This is an unofficial vertical extension of the 14-digit ULPIN
> (Bhu-Aadhaar). It is not an official government identifier**, is not issued
> by or registered with any revenue department, and carries no legal weight.

That sentence is rendered on the ULPIN card in the UI, not hidden in a tooltip.
`lib/ulpin.ts` and `ulpin_fmt()` in `db/02_functions.sql` implement the same
encoding, and `lib/ulpin.test.ts` asserts their agreement.

**Both vertical datums, always.** Every `z` is EGM96 orthometric (mean sea
level); every payload also carries EPSG:4979 ellipsoidal heights against their
own CRS URNs, because the two are ~72 m apart at Visakhapatnam and labelling
one as the other is an error the size of a twenty-storey building. Where a
project records no geoid separation, the ellipsoidal pair is omitted rather
than converted by zero.

---

## What is real and what is not

Enforced in the data model and shown per entity in the DetailPanel — not just
in this prose.

| Layer | Source | Status |
|---|---|---|
| Building footprints, road centrelines, street geometry | OpenStreetMap (ODbL) | **Real** |
| Storey counts / heights | a minority from OSM tags; most estimated by area + building-type heuristic | **Estimated** (badge says which) |
| Ground elevation (siripuram) | CartoDEM v3 1-arc-sec, NRSC/ISRO, sampled per footprint, EGM96 | **Real** (`cartodem_v3`) |
| Ground elevation (other projects) | no DEM tile → 12.0 m default | **Placeholder** |
| LULC class, flood/cyclone hazard zones | NRSC SISDP 1:10k and national layers, live Bhuvan WMS | **Real, external, context only** |
| Flood/cyclone *exposure grading* | `scripts/hazard.py`, computed locally from the DEM + coastline | **Derived** — not an NRSC rating |
| Parcel boundaries | Voronoi plots around clustered footprints | **Derived, not surveyed** |
| Owners, tenure, encumbrances, building register | generated placeholders (`lib/mock/`), deterministic per id | **Synthetic** |
| Section 22A restricted lands | `data/projects/<slug>/section-22a.json` | **Demonstration register** (`register.authoritative: false`) |
| Utility alignments | offsets from road centrelines | **Representative, not as-built** |
| Street names | a handful real from OSM; the rest derived in local convention (*… 1st Cross*) | **Real / Derived**, marked per street |
| Manual edits | typed in the viewer → `data/edits.json` (gitignored) | **Local, no authority** |

`data/surveyed_plans.json` carries a `_synthetic: true` flag threaded all the
way to the DetailPanel, which renders it as **“Surveyed plan (demo)”** —
fabricated data never borrows the authority of a real survey. Deleting
`lib/mock/` and its single call site returns the app to sourced-data-only with
no component changes.

---

## Viewer features

**Drill-down.** City → building → floor → unit, each level picked through the
one above it. An isolated floor shows the level plate, its translucent shell
and every flat on it as co-pickable solids. An isolated **basement** is lifted
above ground into the light — cooler grey, a ring at true ground level, a
dashed tie-line and a caption quoting the stored depth (`B2 · 8.0 m below
ground`). Nothing stored moves.

**Explode & slice.** Explode separates the stack vertically; slice cuts every
ring against a drag plane on the CPU (`lib/geo.ts` + `lib/cesium/section.ts` —
entity geometry has no `clippingPlanes`), re-clipped when the plane moves, not
per frame. The two are mutually exclusive by store rule.

**Basemaps** (Layers panel):

| Imagery | Notes |
|---|---|
| Esri World Imagery | Default. No token. Imagery is colour-graded; buildings stay neutral off-white. |
| Esri Wayback | Historical mosaics. Pick a release in `lib/cesium/imagery.ts`. |
| Mapbox Satellite | Hidden unless `NEXT_PUBLIC_MAPBOX_TOKEN` is set. |
| Dark vector | CARTO `dark_all`; the no-imagery fallback. |
| None | Bare `#0d1219` globe — underground mode, clean captures. |

Switching either basemap or tone swaps layer 0 in place — no rebuild, no camera
move, overlays stay. A failed provider falls back to CARTO with the StatusBar
showing `(fallback)`; the globe is never left untextured.

**ISRO Bhuvan overlays** (siripuram): Land use (SISDP 1:10k), flood and
cyclone hazard zones as WMS `ImageryLayer`s above the basemap, credited
`© NRSC/ISRO Bhuvan`, with `GetLegendGraphic` in the Legend and per-building
`GetFeatureInfo` lookups on the DetailPanel. Because the national hazard
layers are one flat polygon over a 1.2 km AOI, `scripts/hazard.py` also
derives a **local exposure index** painted on the ground in four fixed
classes:

| Weight | Flood | Cyclone |
|---|---|---|
| highest | ground height (0.45) | distance to shoreline (0.50) |
| middle | depth below surroundings within 250 m (0.40) | exposure above surroundings (0.30) |
| lowest | distance to shoreline (0.15) | building height as wind load (0.20) |

Class boundaries are fixed scores, not quantiles, so a class means the same
thing in every project.

**Underground utilities.** Corridors drawn at true depth with depth/class
cues; **conflicts** (`ST_3DIntersects` on solids, never shells) pulse red.
Banjara Hills carries 80 flagged encroachments.

**Section 22A.** The Registration Act 1908 register is drawn on the cadastre it
names — crimson hatch inside the parcel's own borrowed ring, never a reshaped
one. The shipped register is a demonstration (`register.authoritative: false`
governs every surface's wording); connecting a government feed is one module,
`lib/section22a/source.ts`. Entries outside the AOI are counted as “listed, but
not located in this area”, never dropped or guessed.

**ISO 19152 (LADM).** Migration 007 adds `la_party`, `la_ba_unit`,
`la_ba_unit_member`, `la_spatial_unit`, `la_rrr`, filled by
`ladm_backfill(project_id)`. Selecting Flat 901 and opening the **Legal** tab
answers as one record: the volume, Parking Slot P-213 as an appurtenance, and
1/80 of the plot beneath it, with rights, holder and tax demand attached. The
registry stores **no geometry** — `la_spatial_unit` points at existing rows.
The flat register stays a file (`data/projects/<slug>/flat-register.json`);
air-rights volumes are derived at request time from the infra spec, marked
`derived`. Rights are redacted server-side exactly like everything else.

**Editing.** Nine attributes editable — name, type, floors, height, built-up
area, occupancy, address, owner, status. Coordinates and ULPIN are **not**:
they are absent from `BuildingEdit`, so `PATCH` answers `400` for them. The
schema module is shared by form and route, so a rule cannot pass in the
browser and fail on the server. Saves round-trip to `data/edits.json`
(override: `ULPIN_EDITS_PATH`), applied as a pure function over the pristine
snapshot on each read. Editing storeys does **not** regenerate floor/unit
child records — the panel says so when they disagree.

**Accounts.** Session auth with government and citizen roles. Server-side
redaction (`filterDetailForCaller`, `filterLadmForCaller`,
`stripCoreIdentity`): a citizen sees their building with only their own flat's
details and parking bay — neighbours' volumes are anonymous masses — and
structural cores carry no identity at all. Demo logins are listed under the
[desktop app](#windows-desktop-app) (they are committed demo data, shown on
`/login` in the demonstration configuration).

---

## Windows desktop app

The whole app packaged as a native Windows program — no browser, no Node
install, double-click and it opens in its own window.

| Output | What it is |
|---|---|
| `dist/AERO-VIEW-Setup-1.0.0.exe` | **Installer** — Start-menu shortcut, uninstaller, optional install directory |
| `dist/AERO-VIEW-Portable-1.0.0.exe` | **Portable** — single ~131 MB exe, runs from anywhere (USB stick), nothing installed |
| `dist/win-unpacked/AERO-VIEW.exe` | Same build, unpacked as a folder |

Both installers are self-contained: Electron runtime + Next.js standalone
server + the committed data snapshots. Internet is only needed for map
imagery/terrain tiles — **the cadastre works fully offline**.

How it works: `electron/main.js` starts the bundled Next server on
`127.0.0.1:47219` (with port fallbacks), passes `SESSION_SECRET` and
`DATABASE_URL` from `resources/app-bundle/server.env` (never baked into the
exe), waits for `GET /api/projects`, then opens the window. Manual edits land
under `%APPDATA%/AERO-VIEW/edits/` because the install directory is not
writable.

```bash
npm install && npm run desktop:pack   # installer + portable
npm run desktop:dir                   # win-unpacked only
```

Demo logins (committed demo data):

| Role | Login | Password |
|---|---|---|
| Government | `admin@sampath.gov.in` | `ulpin-gov-2026` |
| Citizen — Flat 201 (Ravi Kumar) | `111122223333` | `9876543210` |
| Citizen — Flat 502 (Priya Sharma) | `222233334444` | `9876543211` |
| Citizen — Flat 903 (Anand Rao) | `333344445555` | `9876543212` |

---

## Running the web app

```bash
npm install     # also copies Cesium assets into public/cesium
npm run dev     # http://localhost:3000 — gallery at /, viewer at /p/siripuram
```

The committed snapshots in `data/api/<slug>/` render the full app with no
database at all.

<details>
<summary><strong>With PostGIS</strong> (optional, but the intended backend)</summary>

```bash
docker compose up -d     # postgis/postgis:16-3.4 + SFCGAL, port 55432
npm run seed             # fetch OSM → estimate → seed → utilities → export
```

A **fresh** volume auto-initializes from the `./db` mount
(`01_schema.sql` + `02_functions.sql`). For a volume that predates a feature,
apply the additive, idempotent migrations — never a re-seed:

```bash
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 -f - < db/migrations/001_multi_project.sql
# …likewise 002_cartodem_bhuvan, 003_hazard_exposure, 004_utility_categories,
# 005_survey_parcel, 006_volumetric_units, 007_ladm
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 -f - < db/02_functions.sql
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -c "SELECT * FROM ladm_backfill(1);"
```

</details>

<details>
<summary><strong>Environment variables</strong></summary>

Copy `.env.example` to `.env.local`. The important variables:

| Variable | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | **yes** | HMAC cookie key, shared across processes. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DATABASE_URL` | no | Default `postgresql://ulpin:ulpin@localhost:55432/ulpin`. The deployed copy runs on Neon (pooled endpoint; SFCGAL must be available). |
| `DATABASE_CONNECT_TIMEOUT_MS` | no | 1500 loopback / 12000 remote |
| `NEXT_PUBLIC_CESIUM_TOKEN` | no | Terrain & Photorealistic tiles only — imagery does not use ion. Without it the globe falls back to a flat ellipsoid and says so. |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | no | Unlocks the Mapbox basemap. |
| `ULPIN_REDIS_URL`, `ULPIN_CACHE_VERSION` | no | Read-through cache. |
| `ULPIN_EDITS_PATH` | no | Override the manual-edits file location. |

**The database is optional at runtime.** Route handlers try PostGIS first and
fall back to the committed snapshots per project; every response carries
`x-ulpin-backend: postgis|snapshot` saying which path served it. `404` means
nothing knows the slug; `503` means the project is real but has no snapshot
and the database is not answering — a stopped docker container is not reported
as “project does not exist”.

</details>

<details>
<summary><strong>Generating a new project</strong></summary>

```bash
npm run seed -- --slug=hyderabad-banjara --name="Banjara Hills Ward" \
  --bbox=78.4300,17.4100,78.4450,17.4250 --state=TS --district=HYD
```

Rejected before the first network request: a bbox over **4 km²**, an aspect
ratio worse than **3:1**, or malformed coordinates. The slug must match
`^[a-z0-9][a-z0-9-]{0,63}$`; status is `draft / generating / ready / failed`.
Drop an NRSC CartoDEM tile at `data/projects/<slug>/dem_raw.tif` and run
`seed:geo` for real ground elevation — otherwise the project stays an honest
placeholder.

`npm run seed` is stdlib Python. Only `scripts/dem.py` needs geo libraries;
create the toolchain once, user-space:

```bash
micromamba create -y -p ./.gdal-env -c conda-forge python=3.12 gdal rasterio pyproj
npm run seed:geo   # same arguments as seed
```

</details>

---

## API

<details>
<summary>All cadastre endpoints are scoped by project — expand for the full table</summary>

The seven unscoped paths (`/api/buildings`, …) remain as **thin aliases onto
the demo project** sharing the scoped handler body — byte-identical by
construction.

| Endpoint | Returns |
|---|---|
| `GET /api/p/:slug/buildings` | GeoJSON FeatureCollection of every footprint |
| `GET /api/p/:slug/building/:id` | building + floors + units, nested |
| `PATCH /api/p/:slug/building/:id` | record a manual edit; `400` for a non-editable field, `422` for validation failure |
| `POST /api/p/:slug/query {lon,lat,z}` | every entity whose 3D volume contains the point, ordered parcel < building < floor < unit |
| `GET /api/p/:slug/utilities` | centrelines with depth / radius / authority |
| `GET /api/p/:slug/conflicts` | flagged `ST_3DIntersects` violations |
| `GET /api/p/:slug/parcels` | surface parcels |
| `GET /api/p/:slug/roads` | merged streets with names, classes, lengths (`x-ulpin-roads: derived`) |
| `GET /api/p/:slug/section-22a` | restricted lands as GeoJSON + register block |
| `GET /api/projects[/:slug]` | the registry, with per-project stats |
| `GET /api/p/:slug/ladm/spatial-unit/:suId` | the ISO 19152 document for one spatial unit |
| `GET /api/v1/ladm/parcel/:ulpin3d` | the same document, project resolved from the identifier |

```console
$ curl -s -X POST localhost:3000/api/query -H 'Content-Type: application/json' \
    -d '{"lon":83.3245,"lat":17.72808,"z":64.9}'

parcel    AP-VSP-3D26-0001            P. Sailaja
building  AP-VSP-3D26-0001-001        Water Resourse Block   z 60.16..76.16
floor     AP-VSP-3D26-0001-001-01     Level 1                z 63.36..66.56
unit      AP-VSP-3D26-0001-001-01-02  B02                    z 63.51..66.21
```

The `z` values are metres above mean sea level (EGM96), from the CartoDEM
sample at the building's centroid.

</details>

---

## Architecture

<details>
<summary>Component map, invariants and design decisions — expand</summary>

```
app/                 / gallery, /p/[slug] viewer, /login — api/p/[slug]/* routes
                     + unscoped aliases + api/projects[/slug]
components/globe/    CesiumRoot, CameraDirector, Picker, Scene
components/layers/   BhuvanOverlay, HazardRisk, Parcels, Roads, Buildings,
                     FloorStack, Units, Utilities, Conflict
components/ui/       TopBar, LayerPanel, ActionBar, FloorLadder, DetailPanel,
                     ParcelInset, NavDock, StatusBar, Legend, Provenance, …
lib/                 store, db, ulpin, projects, ladm, bhuvan, hazard,
                     api/handlers, data/*, mock/*, cesium/*, section22a/*
db/                  01_schema.sql, 02_functions.sql (incl. ladm_backfill)
                     migrations/001–007 (upgrade path for existing volumes)
scripts/             seed.py + pipeline, dem.py, hazard.py, build_roads.mjs,
                     check_* and verify_ui harnesses
data/api/<slug>/     per-project snapshots, served when the DB is down
data/projects/<slug>/ inputs, OSM cache, DEM clip, flat register, edits
```

Four rules the code actually obeys (and `grep` can confirm):

1. **One store, few writers** — the Zustand view store is written only by
   `Picker` and the UI controls; layers read and render.
2. **All camera motion lives in `CameraDirector`** — no `flyTo`/`zoomTo`
   anywhere else; `CesiumRoot` does one `setView` to frame the project bbox.
3. **Colours are defined once** — `lib/cesium/materials.ts`.
4. **Every DetailPanel entity shows a provenance line.**

Notable decisions:

- **Metric geometry is built in SQL, not Python** — construction in
  EPSG:32644, stored as EPSG:4326 + Z metres; `ST_MakeSolid` is mandatory
  because `ST_3DIntersects` treats a shell as hollow and the worst
  encroachment (a corridor wholly inside a basement) would go unreported.
- **One animation driver per layer** — hundreds of entities, one
  `requestAnimationFrame` loop, `CallbackProperty` closures.
- **Terrain reconciliation** — stored `ground_elev` (MSL) vs Cesium World
  Terrain (ellipsoidal) is sampled once per building and the difference
  logged; only rendering is shifted.
- **A citizen view is a data decision, not a UI one** — redaction happens
  server-side, so both backends and the desktop app serve the same document.

Full component map and rationale: [`architecture.md`](architecture.md).

</details>

---

## Verification

<details>
<summary>Test and UI-harness commands — expand</summary>

```bash
npm test              # 11 unit-test files: ULPIN/SQL parity, datum, topology,
                      # LADM, basements, cores, Section 22A, …
npm run verify:ui     # drives real Chrome through all five view modes
npm run check:rwd     # 4 viewports × viewer + gallery + 2D GIS
npm run check:edit    # editing guarantees
npm run check:volumetric  # LADM end to end, incl. redaction + both datums
npm run check:22a     # drawn 22A rings vs survey parcels, vertex for vertex
npm run check:roads   # street picking, precedence, tolerance
```

Both pages require a session, and the harnesses have no login step — hand
them a signed cookie minted with the server's own secret:

```bash
export ULPIN_SESSION_COOKIE=$(node --experimental-strip-types scripts/mint_session.mjs)
npm run verify:ui && npm run check:rwd
```

`verify:ui` needs the `window.__ulpinViewer` seam, which a production build
only carries with `NEXT_PUBLIC_ULPIN_PROBE=1`; `npm run dev` has it
unconditionally.

</details>

---

## Known limitations

- **Measurements, Share and Split view** are rendered visibly disabled rather
  than hidden — absence is explicit.
- **Editing a storey count does not regenerate floor/unit records** (child
  cadastral rows are not fabricated; the panel states the disagreement).
- **Streets are snapshot-only** — there is no road table in the schema;
  `GET /api/roads` sends `x-ulpin-roads: derived`.
- `check:roads` carries one pre-existing failing assertion (pick tolerance);
  `check:edit` fails one snapshot-backend-only toast-timing assertion (passes
  on PostGIS).
- `npm run smoke` cannot pass (harness lacks session handling); on Windows,
  `npm start` 400s when the project path contains a space — use `npm run dev`.

---

## Data sources and licences

- **OpenStreetMap** — building footprints, road centrelines: © OpenStreetMap
  contributors, **ODbL**. Everything derived from them inherits the licence.
- **CartoDEM v3** (1 arc-second), © **NRSC/ISRO**, via Bhuvan — ground
  elevation for siripuram. Only the clipped 49 × 43-cell extract is
  redistributed; the 51 MB raw tile is gitignored.
- **Bhuvan WMS** — SISDP 1:10,000 LULC and the national flood/cyclone hazard
  layers, served live, © **NRSC/ISRO**, credited in Cesium's attribution
  container whenever one is on screen. Heavy or commercial use should be
  cleared with NRSC.
- **Esri World Imagery** and Wayback — carries Esri's
  [terms of use](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9)
  for heavy or commercial use.

Attribution is a licence obligation: Esri, Maxar, CARTO, OSM and NRSC/ISRO
credits render bottom-left and must not be hidden.

---

## Repository map

| Document | Contents |
|---|---|
| [`architecture.md`](architecture.md) | Full component map, pipeline, design rationale |
| [`DESKTOP.md`](DESKTOP.md) | Desktop packaging in depth |
| [`docs/DEMO.md`](docs/DEMO.md) | 10-minute demo script with deep links |
| [`HANDOFF.md`](HANDOFF.md) | Working state, known issues, next steps |
| `.env.example` | Every environment variable, annotated |

---

<div align="center">

<sub>Built on real OpenStreetMap footprints, CartoDEM elevations and NRSC/ISRO Bhuvan overlays ·<br/>
An unofficial demo — not an official government product</sub>

</div>
