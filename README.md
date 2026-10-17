# RTL Circuit Visualizer

An interactive tool that turns a documented subset of Verilog / SystemVerilog into an inspectable hardware diagram, built for ECE and VLSI students. Paste RTL, press **Visualize**, and explore the inferred gates, muxes, registers, ports and module instances.

Accuracy and honest diagnostics come before feature count: constructs the tool cannot model are reported with a source location and are never drawn as if they had been analyzed. A successful parse does **not** mean the diagram is synthesis-equivalent.

> No screenshot is checked in. Run `npm run dev` to see the interface.

## Features

- Editor with line numbers, syntax highlighting, diagnostic markers in the gutter, `Ctrl/Cmd+Enter` to visualize, and 18 built-in examples.
- Real tokenizer (line/column tracking) and recursive-descent parser with correct operator precedence/associativity. Leftover tokens are errors, never ignored.
- Hardware IR independent of the DOM: ports, constants, gates, buffers, muxes, comparators, arithmetic, shifts, reductions, concatenation/slices, D flip-flops (clock, reset, enable), module instances, widths with exact ranges, driver lists, source locations, and stable node ids.
- Pin-accurate connections with fan-out, bus-width labels, orthogonal wire routing, and feedback wires routed below the diagram.
- Detection of multiple drivers, undriven bits, unused signals, undeclared names, latch inference, width mismatches, unknown modules, recursive hierarchy, and unsupported syntax.
- Analysis status: *complete for supported constructs*, *complete with warnings*, *partial visualization*, *analysis failed*.
- Pan, zoom, fit, reset layout, draggable nodes, node/wire selection, fan-in/fan-out tracing, inspector, statistics, module hierarchy navigation, and per-node RTL explanations.
- SVG export (styles inlined, standalone) and PNG export.
- Light and dark themes (dark by default), responsive layout, no network access needed after install.

## Prerequisites

Node.js 20.19+ (or 22.12+) and npm.

## Commands

```bash
npm install        # install dependencies
npm run dev        # start the dev server (http://localhost:5173)
npm run build      # type-check and create the production build in dist/
npm run preview    # serve the production build locally
npm test           # run the Vitest suite once
npm run typecheck  # TypeScript only
```

Icarus Verilog and Yosys are optional. When `iverilog` / `yosys` are on the PATH, `tests/integration/examples.test.ts` additionally compiles every example with Icarus (`-g2012`) and runs `read_verilog; hierarchy; proc` in Yosys. When they are missing those tests are skipped, and the app never needs them.

## Deploying to Vercel

1. Push the project to a Git repository and import it in Vercel.
2. Framework preset: **Vite**. Build command: `npm run build`. Output directory: `dist`.
3. Deploy. The build uses relative asset paths (`base: './'`), so it also works from a sub-path or static host.

## Supported RTL subset

| Area | Supported |
|---|---|
| Modules | ANSI port lists, `#(parameter ...)` headers, `endmodule` recovery |
| Declarations | `input` / `output` / `inout`, `wire`, `reg`, `logic`, `signed`, vector ranges with any bounds (`[7:0]`, `[15:8]`, `[0:7]`), `parameter`, `localparam`, `wire x = expr;` |
| Expressions | `?:`, `\|\| && \| ^ ~^ & == != === !== < <= > >= << >> <<< >>> + - * / % **`, unary `+ - ! ~`, reductions, parentheses, sized/unsized literals in bases b/o/d/h, bit-selects, constant part-selects, variable bit-selects, concatenation, replication, `$clog2` |
| Continuous logic | `assign` to a signal, constant bit/part-select, or a concatenation |
| Combinational blocks | `always_comb`, `always @*`, `always @(a or b)`, `if` / `else`, `case`, blocking assignments to whole signals or concatenations of signals |
| Sequential blocks | `always_ff`, `always @(posedge/negedge clk [or posedge/negedge rst])`, nested `if` / `case` |
| Sequential inference | Clock edge, asynchronous reset with polarity (from the edge) and constant value, synchronous reset (recognized from a `rst/reset/clr/clear` name and a constant value), enable inferred from hold paths (including `q <= q`), combined nested enables |
| Hierarchy | Named or positional port connections, parameter overrides (`#(.W(8))` or positional), unknown/missing/duplicate ports, recursion detection; instances are drawn as unexpanded boxes |

A `case` over a selector of 4 bits or fewer with constant labels becomes one N:1 mux; other cases become comparator + 2:1 mux chains.

## Known limitations

- Not a Verilog/SystemVerilog implementation. Not supported (reported, not hidden): non-ANSI port lists, generate blocks, `for`/`while`/`repeat` loops, functions and tasks, `initial`, memories/arrays, packed structs, interfaces, packages, gate primitives, `casez`/`casex` wildcards, indexed part-selects (`+:`/`-:`), delays and timing controls, tri-state/`inout` behavior, 4-state (X/Z) semantics, `defparam`, and `.*` connections.
- Assignments to a bit or part of a vector *inside procedural blocks* are not modeled (continuous `assign` to bit-ranges is).
- Synchronous resets are recognized by signal name plus a constant value; a differently named synchronous reset is drawn as ordinary data logic.
- Signedness is parsed but arithmetic is not modeled as signed; widths follow a simplified version of Verilog's context rules.
- Multiple drivers are flagged and drawn as a conflict node; no resolution strategy is simulated.
- Layout is a layered left-to-right layout with orthogonal wires. Wires between adjacent columns can overlap or cross each other, and there is no obstacle avoidance beyond routing column-skipping and feedback wires around the node field. Very large designs (over 4000 nodes, 200 000 characters, or 100 modules) are rejected with a diagnostic.
- PNG export depends on the browser's SVG rasterization and was not exercised in a real browser during development.

## Architecture

```
src/
  main.ts                 app wiring (DOM, state, panels)
  parser/                 lexer, expression parser, module parser, diagnostics, AST types
  analysis/               hardware IR, widths/constants, combinational + sequential lowering,
                          connectivity/driver checks, hierarchy, analyze() entry point
  visualization/          layout, wire routing, SVG renderer, pan/zoom/drag interactions, export
  panels/                 statistics, inspector + explanations, diagnostics, hierarchy
  editor/                 editor widget, syntax highlighter, example library
  utils/                  safe DOM helpers, validation, escaping
  styles/                 main.css, editor.css, circuit.css
tests/
  unit/                   lexer, expression parser, widths, combinational, sequential, connectivity
  integration/            parser + hierarchy, all examples, SVG rendering / interactions / app shell (jsdom)
  fixtures/rtl-examples/  Verilog fixtures used by the tests
```

Data flow: source → `tokenize` → `parseSource` (AST) → `analyzeModule` (hardware IR: nodes, pins, connections, drivers, diagnostics) → `layoutModel` → `CircuitRenderer` (SVG built with DOM APIs; user text is only ever assigned via `textContent` or attributes).

## Roadmap

- Obstacle-avoiding wire routing and crossing minimization.
- Generate blocks, constant loops, functions, memories.
- Partial assignments in procedural blocks, signed arithmetic, `casez`/`casex`.
- Non-ANSI ports and gate primitives.
- Optional expansion of child modules inside the parent diagram.
- Shareable links and diagram export to other formats.
