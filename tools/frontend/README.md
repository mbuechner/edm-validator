# Frontend dependencies

The root `package.json` declares every browser dependency; `package-lock.json`
pins the complete npm dependency tree. No downloaded library is kept in `src/`.

`npm ci --ignore-scripts` followed by `npm run build` creates the complete browser
tree in `target/frontend/`. The build copies application sources and obtains
Bootstrap, Prism and Oxigraph's browser module/WASM from their installed packages.
Esbuild bundles the graph with one shared Three.js module and bundles Saxes with
its XML character definitions. Package sources and warnings remain unmodified.
Original licenses and SHA-256 manifests are generated alongside the libraries.
Browser URLs use stable filenames; dependency versions are recorded in the
package manifests so a package update does not leave stale versioned imports.
The few license texts missing from the pinned npm archives are retained under
`licenses/`; they contain no library code. The build first uses package-supplied
licenses, then selects a fallback by package name and SPDX identifier, without a
versioned directory lookup.

Maven installs the pinned Node/npm tools locally under `target/`, runs these steps
in `generate-resources`, and packages the result as `static/`. Docker uses the same
Maven build. The runtime container needs only Java and serves its assets locally.

All top-level HTML pages include `<!-- include: navigation -->` once. The build
replaces it with `fragments/navigation.html` and marks the link whose
`data-nav-page` matches the page filename with the active styles and
`aria-current="page"`. Edit this fragment to change the menu for every tool.
The generated pages contain the complete navigation without a runtime fetch or
additional JavaScript. Relative links and image URLs preserve context paths.

Run `npm test` for the frontend tests or `npm run test:browser` for the native
Chrome regression. Browser tests use an existing Chrome/Edge installation or
`GRAPH_BROWSER_EXECUTABLE`; npm does not download a browser.
