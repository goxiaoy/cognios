# Search-sidecar packaging spike

**Plan reference:** [docs/plans/2026-04-26-004-feat-cross-workspace-search-plan.md](../../docs/plans/2026-04-26-004-feat-cross-workspace-search-plan.md), Unit 0.

**Goal:** prove a PyInstaller `--onedir` bundle of the v1 sidecar's deep-ML
dependencies (FastAPI, lancedb, ONNX Runtime, PyMuPDF, transformers,
PaddleOCR, llama.cpp) can be built, booted, and codesigned on macOS arm64
*before* Phase 2 commits to the architecture.

The spike is intentionally minimal — `hello.py` imports each dep at module
level and exposes `/spike` which performs one trivial call into each. The
real sidecar lives at `sidecar/search_sidecar/` once Phase 1 begins.

## How to run

```sh
cd sidecar/spike
./build_spike.sh
```

The script uses `uv sync --python 3.13` to materialise `.venv/`, runs
PyInstaller, boots the resulting binary, and captures findings to
`build.log`.

## Headline (2026-04-26 run, host: macOS arm64, Python 3.13.12)

The **core stack bundles cleanly**: lancedb (Rust extension via PyO3),
pyarrow, ONNX Runtime, PyMuPDF, FastAPI, uvicorn all import inside a
PyInstaller `--onedir` bundle, the embedded HTTP server starts, and one
trivial call into each dep returns a typed result. Wall-clock spawn-to-
listening is **1.16 s** (warm cache); in-process import time after the
Python interpreter init is **61 ms**. ONNX Runtime exposes
`CoreMLExecutionProvider` inside the bundle — Metal acceleration for the
embedding + reranker is reachable.

The **captioning pipeline is the highest-friction piece** —
`llama-cpp-python` is sdist-only on PyPI (no prebuilt wheel for any
platform) and requires `cmake` + `xcode-select` to build from source.
This significantly affects CI bundle time and developer prereq docs;
serious enough that a `llama-server`-out-of-process alternative deserves
explicit Phase 2 evaluation. **Captioning is excluded from spike v1**;
the rest of the v1 dep set is validated.

The **rest of the v1 dep set is plausible** but not proven by this
spike: transformers, optimum.onnxruntime, and paddleocr (or
paddleocr-onnx) were deferred to spike v2 to keep the smoke loop
fast. They are conventional Python deps; the high-risk pieces (Rust
extensions, native dylibs, CoreML provider) are already validated.

## Findings

### F-1 — `llama-cpp-python` is sdist-only on PyPI for **all** platforms

**Severity:** HIGH — affects v1 captioning pipeline and any CI that builds
the sidecar without a pre-warmed cmake toolchain.

`llama-cpp-python` (latest 0.3.20 as of 2026-04-26) ships only
`llama_cpp_python-0.3.20.tar.gz` on PyPI; no `cp3xx-macosx_*_arm64.whl`
exists. The `abetlen/llama-cpp-python` GitHub release `v0.3.20-cu123`
publishes only CUDA wheels — no macOS arm64 prebuilts there either.

Every install triggers a source build via scikit-build-core which:
- Requires `cmake` (not present by default on macOS — see F-2).
- Requires `xcode-select --install` (Apple's command-line tools).
- Builds llama.cpp from source (~5–10 min on M-series; longer with
  Metal backend enabled).
- Pulls the result through PyInstaller as a compiled extension; the
  `ggml-metal.metal` Metal shader file must be collected via
  `--add-data` or PyInstaller will silently omit it and inference
  segfaults at first call.

**Implication for the plan:**

- Phase 0 / Unit 0 (or Unit 12's packaging script) must add `cmake` +
  `xcode-select` as **prerequisites** in `docs/sidecar/packaging.md`.
- The PyInstaller invocation must explicitly collect
  `ggml-metal.metal` and `libllama.dylib` from
  `site-packages/llama_cpp/lib/` — this is `--add-data
  '<venv>/lib/python3.13/site-packages/llama_cpp/lib/*:llama_cpp/lib'`
  or equivalent.
- CI bundle build time is dominated by the llama.cpp compile, not by
  PyInstaller itself.
- **Alternative under consideration for Unit 4 / Phase 2:** ship the
  official `llama-server` HTTP binary (the C++ server distributed with
  llama.cpp itself, which publishes prebuilt macOS arm64 artifacts) and
  have the Python sidecar shell out to it via HTTP. Swaps a Python
  source-build for a precompiled C++ binary that we drop in
  `src-tauri/binaries/` alongside `search-sidecar`. Adds one process to
  the topology but eliminates the `cmake` source-build dependency
  entirely. Decision deferred to Phase 2; this spike's finding is
  evidence that the embedded-Python path is materially harder.

### F-2 — `cmake` is not a default macOS developer tool

**Severity:** LOW (documentation gap)

The spike uncovered that `cmake` is not present on a stock developer
machine. Add to `docs/sidecar/packaging.md` before any Phase 2 work:

```sh
brew install cmake
xcode-select --install   # if not already done
```

Without this, the source build for `llama-cpp-python` (and any other
native build that ships sdist-only) fails before reaching PyInstaller.

### F-3 — `--collect-all numpy` is **mandatory** for numpy 2.x bundles

**Severity:** MEDIUM — bundle boots cleanly without it (the build
succeeds), but **runtime crashes on first import** with:

```
ModuleNotFoundError: No module named 'numpy._core._exceptions'
```

Numpy 2.x re-organised its C-extension layout under `numpy._core` and
PyInstaller's automatic-collect rules don't pick up the full subtree
without explicit `--collect-all numpy`. Confirmed reproducer: build with
`--collect-all lancedb pyarrow` only, run the bundle, observe the
ImportError; rebuild with `--collect-all numpy` added, observe success.

**Implication for the plan:** Unit 12's PyInstaller invocation must
include `--collect-all numpy`. The hidden-imports list in the plan's
Unit 12 already mentions transformers / accelerate / tokenizers but
omits numpy; correct that before Phase 5 begins.

### F-4 — Bundle size and top contributors (spike v1 scope)

Bundle scope: fastapi + uvicorn + lancedb + pyarrow + pymupdf +
onnxruntime + numpy. **Total: 335 MB** (`du -sh dist/...`).

Top contributors under `_internal/`:

| Package        | Size | Notes |
|----------------|------|-------|
| pyarrow        | 101 MB | dominant; lance / lancedb depends on it |
| lancedb        | 96 MB  | includes the Rust extension `liblance*.dylib` |
| onnxruntime    | 51 MB  | includes CoreML EP dylib |
| pymupdf        | 44 MB  | includes static-linked libmupdf |
| numpy          | 7 MB   | C extensions only after `--collect-all` |
| Python.framework | 5 MB | CPython 3.13 runtime |
| (everything else) | ~30 MB | uvicorn, websockets, pydantic-core, lib-dynload, etc. |

**Extrapolation for the full v1 bundle** (this spike + the deferred
deps): rough estimate **~700 MB – 1.2 GB** on macOS arm64, depending
on whether transformers + optimum pull torch (the brainstorm and plan
both target the no-torch path via `optimum.onnxruntime`, which keeps
this manageable). PaddleOCR-onnx is roughly 150 MB; a compiled
`llama-cpp-python` is ~80 MB of `_internal/llama_cpp/lib/`. **None of
this includes model weights** (the ~4.3 GB first-run download is
separate and lives under `~/.cogios/search/models/`).

### F-5 — Cold-start performance

| Metric | Value | Notes |
|---|---|---|
| Wall-clock spawn-to-listening | **1.16 s** | warm cache, second consecutive boot |
| In-process import time (per `/spike` boot_seconds field) | **0.061 s** | from interpreter init to FastAPI accept loop |
| First-ever boot from cold disk cache | not measured | requires `sudo purge` or reboot — spike host doesn't grant sudo without prompt |

Implications for the plan:

- The plan's Reliability Decisions section claims "3–10 s on a typical
  Mac SSD" for cold-start. The 1.16 s warm-cache number is a lower
  bound; first-boot from a cold disk cache will be slower (Apple's mmap
  has to fault in 335 MB of dylibs the first time). The 3–10 s estimate
  remains plausible but should be measured on the actual v1 bundle once
  transformers + paddleocr + optional llama_cpp are added.
- The "lazy model loading" decision in the plan (sidecar serves
  `/healthz` immediately after socket bind, models load in a background
  thread) is the right design — even with this lean spike, 1.16 s is
  noticeable for a Cmd+K palette user.

### F-6 — PyInstaller ad-hoc codesigns the binary, but the bundle
structure is not yet release-valid

`PyInstaller 6.11.1` automatically applies an ad-hoc signature
(`Code signing identity: None`) to the EXE during the build's "Re-signing
the EXE" step. Running `codesign --deep --options runtime --sign -` on
the resulting bundle returns "is already signed" — i.e., the build did
the signing.

However, `codesign --verify --verbose=2 dist/search-sidecar-spike`
reports:

> code has no resources but signature indicates they must be present

This is a known PyInstaller-on-Darwin quirk where the resource-bundle
manifest declares resources (e.g., the `_internal/` directory) but the
signing layer does not include them. Production release builds need to:

1. Strip the ad-hoc signature: `codesign --remove-signature dist/...`
2. Re-sign with a Developer ID and an `entitlements.plist`:
   `codesign --deep --options runtime --entitlements entitlements.plist --sign 'Developer ID Application: ...' dist/...`
3. Notarize via `xcrun notarytool submit`.

Unit 12 should call this out — the ad-hoc dev signature is fine for
spikes and dev runs, but the release pipeline must do step 1–3.

### F-7 — ONNX Runtime CoreMLExecutionProvider is available inside the bundle ✓

The `/spike` response includes:

```json
"onnxruntime": {
  "ok": true,
  "version": "1.20.1",
  "providers": ["CoreMLExecutionProvider", "AzureExecutionProvider", "CPUExecutionProvider"]
}
```

This confirms ONNX Runtime's CoreML EP — required for Metal-accelerated
embedding + reranker inference on macOS arm64 — is reachable from inside
a PyInstaller bundle without any extra `--collect-binaries` flag for the
provider dylib. The plan's Phase 2 latency target (<300 ms p95) depends
on Metal acceleration; this is the first concrete evidence the EP
survives bundling.

### F-8 — Network / supply-chain observation

The first `uv sync` against the full pyproject.toml (with
`llama-cpp-python` included) hung for 15+ minutes attempting to download
build metadata for the source build. Killed and re-run without
llama-cpp-python; the second sync completed once a piecemeal install
order was used.

This is **not a finding about uv** (uv handled the cancellation cleanly
and the per-package install was fast), but rather a CI signal: the v1
sidecar build will need either (a) a hash-pinned `uv.lock` committed to
the repo so CI doesn't re-resolve transitive deps every run, or (b) a
warm Python wheel cache. The plan's Unit 12 already commits to
`requirements.lock` with `--require-hashes`; this spike confirms the
plan was right to make that mandatory rather than aspirational.

## What spike v1 did NOT validate

These are explicitly out of scope for this spike and need their own
validation pass before Phase 2 / Unit 12 commits:

1. **transformers + optimum.onnxruntime**. Should bundle similarly
   (pure-Python except for tokenizers/safetensors C bits which are
   well-supported by PyInstaller). Risk: medium.
2. **paddleocr (or paddleocr-onnx)**. Brings opencv, pyclipper, shapely
   — all native deps. Risk: medium-high (heavy install seen in the
   first uv sync attempt).
3. **llama-cpp-python end-to-end** (build → bundle → boot → caption).
   Requires the cmake/xcode prereq + the Metal-shader file collection.
   Risk: HIGH; this is the spike v2 priority.
4. **Cold-disk-cache boot time**. Requires `sudo purge` or a reboot.
   Worth measuring once the full v1 bundle exists, since the plan's
   3–10 s claim is the basis for the supervisor's 30 s startup budget.
5. **CSP-compatible asset rendering**. The spike doesn't exercise any
   webview-loaded asset paths; that's a Unit 12 / Unit 8 concern.

## Spike v2 priorities

In order of value:

1. Resolve the captioning pipeline: build `llama-cpp-python` from
   source with `cmake`, confirm the Metal shader file is collected by
   PyInstaller, boot the bundle, run a minimal caption against a real
   GGUF model. **OR** drop `llama-cpp-python` from the sidecar and ship
   the official `llama-server` binary as a sibling under
   `src-tauri/binaries/` — measure both paths, pick the cheaper one.
2. Add transformers + optimum.onnxruntime + paddleocr to the bundle,
   confirm boot + smoke. The first sync attempt's 15-minute hang
   suggests these need separate verification.
3. Measure cold-disk-cache boot time on the full bundle.
4. Wire a hash-pinned `uv.lock` and run a CI smoke build on a clean
   macOS arm64 runner to validate reproducibility.

## Files

- `pyproject.toml` — uv-managed dep set (no lockfile; spike-only).
- `hello.py` — FastAPI app exposing `/spike` and `/healthz`.
- `build_spike.sh` — uv sync → PyInstaller → boot → curl → codesign.
- `build.log` — full output of the most recent run (gitignored).
- `dist/`, `build/`, `.venv/` — PyInstaller + uv outputs (gitignored).

## Decisions to feed back into the plan

1. **Add F-1 / `llama-server` alternative as an explicit Unit 4 option.**
   The plan currently assumes `llama-cpp-python` in-process; the spike
   shows that's the most expensive bundle path. Phase 2 needs to make
   an informed pick before committing.
2. **Add `--collect-all numpy` to Unit 12's PyInstaller invocation.**
   The plan's hidden-imports list is otherwise correct; numpy is a
   silent gap.
3. **Add `cmake` + `xcode-select` to the developer prereqs list** in
   Unit 12's `docs/sidecar/packaging.md` deliverable.
4. **Adopt `--collect-all` over `--collect-binaries`** for any package
   shipping native data files (most ML wheels). The build_spike.sh
   uses the correct mix; document this convention.
5. **Confirm the no-torch path** for transformers + optimum in spike
   v2; if torch sneaks in, the bundle jumps by ~700 MB.
