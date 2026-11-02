# Supplemental upstream licenses

Some npm archives of Saxes and Oxigraph omit their standalone license files.
The build prefers license files from the installed package. When they are absent,
these upstream texts are selected by package name and matching SPDX identifier,
independently of the installed version. JavaScript and WASM always come from npm.

- Saxes: https://github.com/lddubeau/saxes/tree/v6.0.0
- Oxigraph: https://github.com/oxigraph/oxigraph/tree/v0.5.13

`manifest.json` records the upstream source of each retained license text and its
SPDX identifier. A changed license requires a matching text; the build reports
this explicitly instead of silently using a different license.
