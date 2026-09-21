# Third-party software notices

UnitV Browser Lab includes or is built with the open-source software listed below. The versions are taken from `package-lock.json`. Copyrights and trademarks belong to their respective owners. This project is not endorsed by M5Stack, Sipeed, GitHub, or the projects listed here.

## Software shipped to the browser

| Software | Version | License | Source / license |
| --- | ---: | --- | --- |
| Pyodide | 0.28.3 | Mozilla Public License 2.0 | <https://github.com/pyodide/pyodide/tree/0.28.3> |
| Ruff WASM (`@astral-sh/ruff-wasm-web`) | 0.16.1 | MIT | <https://github.com/astral-sh/ruff> |
| CodeMirror autocomplete | 6.20.3 | MIT | <https://github.com/codemirror/autocomplete> |
| CodeMirror commands | 6.11.1 | MIT | <https://github.com/codemirror/commands> |
| CodeMirror Python language support | 6.2.1 | MIT | <https://github.com/codemirror/lang-python> |
| CodeMirror language | 6.12.4 | MIT | <https://github.com/codemirror/language> |
| CodeMirror lint | 6.9.7 | MIT | <https://github.com/codemirror/lint> |
| CodeMirror merge | 6.12.2 | MIT | <https://github.com/codemirror/merge> |
| CodeMirror search | 6.7.2 | MIT | <https://github.com/codemirror/search> |
| CodeMirror state | 6.7.5 | MIT | <https://github.com/codemirror/state> |
| CodeMirror view | 6.43.12 | MIT | <https://github.com/codemirror/view> |
| Lezer (`@lezer/common`, `highlight`, `lr`, `python`) | 1.5.2 / 1.2.3 / 1.4.10 / 1.1.19 | MIT | <https://github.com/lezer-parser> |
| `@marijn/find-cluster-break` | 1.0.4 | MIT | <https://github.com/marijnh/find-cluster-break> |
| crelt | 1.0.7 | MIT | <https://github.com/marijnh/crelt> |
| style-mod | 4.1.4 | MIT | <https://github.com/marijnh/style-mod> |
| w3c-keyname | 2.2.8 | MIT | <https://github.com/marijnh/w3c-keyname> |
| fflate | 0.8.3 | MIT | <https://github.com/101arrowz/fflate> |

Pyodide is distributed under the Mozilla Public License 2.0. The full license text and corresponding source are available from <https://github.com/pyodide/pyodide/blob/0.28.3/LICENSE> and <https://github.com/pyodide/pyodide/tree/0.28.3>. UnitV Browser Lab does not modify Pyodide's source files; the published build copies the upstream runtime artifacts from the npm package.

Ruff's npm package contains its MIT license and notices for code from autoflake, autotyping, Flake8 and related plugins, isort, pycodestyle, pydocstyle, Pyflakes, Pyright, pyupgrade, Rome Tools, RustPython, and rust-analyzer/text-size. Those notices remain in `node_modules/@astral-sh/ruff-wasm-web/LICENSE` after `npm install` and in the upstream repository at <https://github.com/astral-sh/ruff>.

## Build and development dependencies

The following tools are used to build or test the project and are not intentionally exposed as separate application APIs.

| Software | Version | License |
| --- | ---: | --- |
| Vite | 7.3.6 | MIT |
| Rollup and optional platform packages | 4.63.4 | MIT |
| esbuild and optional platform packages | 0.28.2 | MIT |
| PostCSS | 8.5.28 | MIT |
| nanoid | 3.3.19 | MIT |
| fdir | 6.5.0 | MIT |
| tinyglobby | 0.2.17 | MIT |
| picomatch | 4.0.7 | MIT |
| picocolors | 1.1.1 | ISC |
| source-map-js | 1.2.1 | BSD-3-Clause |
| ws | 8.21.3 | MIT |

License identifiers in this document are SPDX identifiers. Exact dependency versions and transitive relationships are recorded in `package-lock.json`; the installed packages contain their upstream license files after `npm ci`.
