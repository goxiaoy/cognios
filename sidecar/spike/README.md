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

**Severity:** HIGH (now **RESOLVED** — see "Resolution" below).

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

**Original implication for the plan (now superseded by the resolution above):**

- The PyInstaller invocation would have needed `--add-data
  '<venv>/lib/python3.13/site-packages/llama_cpp/lib/*:llama_cpp/lib'`
  to bundle `ggml-metal.metal` and `libllama.dylib`.
- CI bundle build time would have been dominated by the llama.cpp
  source-compile step.
- Developer machines would have needed `brew install cmake` and
  `xcode-select --install` as prereqs.

None of this applies in the resolved design — `llama-server` is a single
prebuilt binary that we drop into `src-tauri/binaries/llama-server-<host-tuple>`
and the Tauri bundler ships it inside the same `.app` / `.dmg` as
`search-sidecar`. The user still gets a single installer.

### F-2 — `cmake` is not a default macOS developer tool

**Severity:** LOW (now **MOOT** — only consumer was `llama-cpp-python`,
which has been replaced with the prebuilt `llama-server` binary).

The spike uncovered that `cmake` is not present on a stock developer
machine. With the F-1 resolution this is no longer a blocker — no
sidecar dep requires source-build. Kept here as a record. If a future
sidecar dep ever ships sdist-only, `brew install cmake` +
`xcode-select --install` are the standard remediation.

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
separate and lives under `~/.cogios/models/`).

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
3. **`llama-server` end-to-end** (fetch prebuilt binary → bundle into
   `src-tauri/binaries/` → spawn from Rust supervisor → POST a base64
   image to `/v1/chat/completions` → confirm Gemma 3n vision response).
   The F-1 resolution moved this from "build a Python wheel from source"
   to "fetch a prebuilt binary"; risk dropped from HIGH to MEDIUM.
4. **Cold-disk-cache boot time**. Requires `sudo purge` or a reboot.
   Worth measuring once the full v1 bundle exists, since the plan's
   3–10 s claim is the basis for the supervisor's 30 s startup budget.
5. **CSP-compatible asset rendering**. The spike doesn't exercise any
   webview-loaded asset paths; that's a Unit 12 / Unit 8 concern.

## Spike v2 priorities

In order of value (post F-1 resolution — `llama-server` chosen):

1. **`llama-server` end-to-end smoke.** Fetch the pinned llama.cpp
   release binary for macOS arm64, drop it at
   `src-tauri/binaries/llama-server-aarch64-apple-darwin`, spawn from a
   stub Rust supervisor with `-m <gemma-gguf> --mmproj <vision-gguf>
   --host 127.0.0.1 --port 0 --api-key <token>`, POST a base64-encoded
   test image to `/v1/chat/completions`, confirm Gemma 3n vision
   returns a sensible caption. This validates the captioning pipeline
   end-to-end without needing the full sidecar.
2. Add transformers + `optimum.onnxruntime` + paddleocr (or
   paddleocr-onnx) to the spike bundle, confirm boot + smoke. The first
   uv sync attempt's 15-minute hang suggests these need separate
   verification.
3. Measure cold-disk-cache boot time on the full bundle (post #2).
4. Wire a hash-pinned `uv.lock` for the sidecar Python deps and a
   pinned `llama_server_manifest.toml` for the C++ binary; run a CI
   smoke build on a clean macOS arm64 runner to validate
   reproducibility.

## Files

- `pyproject.toml` — uv-managed dep set (no lockfile; spike-only).
- `hello.py` — FastAPI app exposing `/spike` and `/healthz`.
- `build_spike.sh` — uv sync → PyInstaller → boot → curl → codesign.
- `build.log` — full output of the most recent run (gitignored).
- `dist/`, `build/`, `.venv/` — PyInstaller + uv outputs (gitignored).

## Decisions fed back into the plan (2026-04-26)

1. ✅ **F-1 resolved → `llama-server` out-of-process.** Plan Architecture,
   Unit 2 (supervisor spawns both children), Unit 4 (no llama_cpp wheel
   download — only Gemma GGUF weights), Unit 5 (image processor calls
   `llama-server` over HTTP), Unit 12 (`fetch_llama_server.sh` +
   `llama_server_manifest.toml`) all updated.
2. ✅ **`--collect-all numpy` added** to Unit 12's PyInstaller recipe.
3. ✅ **`cmake` + `xcode-select` removed** from the developer prereqs
   list — no remaining sidecar dep requires them.
4. **Adopt `--collect-all` over `--collect-binaries`** for any package
   shipping native data files (most ML wheels). The build_spike.sh
   uses the correct mix; document this convention in
   `docs/sidecar/packaging.md` (Unit 12).
5. **Confirm the no-torch path** for transformers + optimum in spike
   v2; if torch sneaks in, the bundle jumps by ~700 MB.
