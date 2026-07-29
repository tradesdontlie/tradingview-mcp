# Baby Biker Codex Pet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create and install a Codex-compatible v2 animated pet of the referenced baby permanently seated on a compact gray three-wheel motorcycle and permanently wearing white-framed, black-lensed sunglasses.

**Architecture:** Use the installed `hatch-pet` workflow as the sole atlas-production pipeline. Image generation creates one canonical base and coherent row strips grounded in the four user references; bundled deterministic scripts extract, normalize, validate, assemble, despill, and package the final 8x11 atlas.

**Tech Stack:** Codex built-in image generation, `hatch-pet` Python/Pillow scripts, JSON manifests, PNG/WebP assets, Codex pet manifest v2.

## Global Constraints

- Use all four supplied photographs as identity and wardrobe references.
- The baby remains seated on and physically connected to the motorcycle in every animation cell.
- White-framed sunglasses with opaque black lenses remain on the baby in every animation cell.
- Preserve the black beanie, black-and-cream biker jacket, dark trousers, black boots, round face, and graphite-gray three-wheel motorcycle.
- Use a polished chibi sprite style; avoid photorealism, readable logos or plates, text, scenery, shadows, guide marks, and detached effects.
- Final cells are `192x208`; final atlas is `1536x2288`; `pet.json` uses `spriteVersionNumber: 2`.
- Use only the bundled workspace Python returned by `codex_app__load_workspace_dependencies`; never use bare system Python.
- Keep run artifacts under `C:\Users\ADMIN\.codex\pet-runs\baby-biker` and the installed pet under `C:\Users\ADMIN\.codex\pets\baby-biker`.

---

### Task 1: Prepare the Baby Biker run

**Files:**
- Read: `C:\Users\ADMIN\tradingview-mcp\docs\superpowers\specs\2026-07-29-baby-biker-codex-pet-design.md`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\pet_request.json`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\imagegen-jobs.json`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\prompts\*`

**Interfaces:**
- Consumes: four source PNG paths supplied in the conversation and the approved design document.
- Produces: a prepared run manifest whose jobs, prompts, layout guides, chroma key, pet id, and output paths drive every later task.

- [ ] **Step 1: Load the bundled runtime**

Call `codex_app__load_workspace_dependencies` and set `$PetPython` to the exact returned Python executable.

- [ ] **Step 2: Prepare the run**

Run `prepare_pet_run.py` with pet name `Baby Biker`, output directory `C:\Users\ADMIN\.codex\pet-runs\baby-biker`, style preset `3d-toy`, all four `--reference` paths, and pet notes requiring the seated vehicle pose and permanent white-frame black-lens sunglasses.

- [ ] **Step 3: Verify preparation**

Inspect `pet_request.json` and `imagegen-jobs.json`. Expected: pet id `baby-biker`; jobs cover base, nine standard states, four cardinal anchors, and two coherent look rows; every non-base visual job lists grounding images and a layout guide.

### Task 2: Establish the canonical character and vehicle

**Files:**
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\decoded\base.png`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\references\canonical-base.png`
- Modify: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\imagegen-jobs.json`

**Interfaces:**
- Consumes: `prompts/base-pet.md` and all four source photographs.
- Produces: one approved canonical reference used to lock face, clothing, sunglasses, vehicle design, palette, proportions, and seated pose across all animation rows.

- [ ] **Step 1: Generate the base with one isolated visual worker**

The worker must use `imagegen`, attach every listed reference, and return only `selected_source=...` and `qa_note=...`.

- [ ] **Step 2: Check the base identity**

Accept only one centered full-body chibi baby seated on a compact gray three-wheel motorcycle, wearing the black beanie, black-and-cream jacket, boots, and white sunglasses with clearly opaque black lenses on a flat chroma-key background.

- [ ] **Step 3: Record the approved base**

Copy the selected source to both `decoded\base.png` and `references\canonical-base.png`, then mark only the `base` job complete in `imagegen-jobs.json`.

### Task 3: Generate and validate the nine standard animation rows

**Files:**
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\decoded\<state>.png`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\qa\rows\<state>\review.json`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\final\spritesheet.webp`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\qa\contact-sheet.png`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\qa\previews\*.gif`

**Interfaces:**
- Consumes: canonical base, state prompts, and matching layout guides.
- Produces: validated rows `idle`, `running-right`, `running-left`, `waving`, `jumping`, `failed`, `waiting`, `running`, and `review`, plus the intermediate 8x9 atlas and motion previews.

- [ ] **Step 1: Generate identity and gait checks**

Generate `idle` and `running-right` as separate visual jobs. The baby and motorcycle must move as one connected unit; the glasses must remain present with black lenses in all eight frames.

- [ ] **Step 2: Decide the leftward row**

Mirror `running-right` only if flipping preserves identity, vehicle geometry, clothing, sunglasses, and direction semantics. Otherwise generate `running-left` as a grounded row job.

- [ ] **Step 3: Generate the remaining standard rows**

Use one isolated visual worker per row and up to three concurrent workers for independent ready jobs. Each output must contain exactly eight separated, unclipped poses on the chosen flat chroma background.

- [ ] **Step 4: Validate every row immediately**

For each row, run `extract_strip_frames.py --method auto`, then `inspect_frames.py --require-components`. Repair a failing visual row; use `stable-slots` only when the source strip is visually stable and extraction caused motion popping.

- [ ] **Step 5: Build and inspect the standard atlas**

Run `extract_strip_frames.py --states all`, `inspect_frames.py --require-components`, `compose_atlas.py`, `make_contact_sheet.py`, and `render_animation_previews.py`. Expected: no review errors, correct state semantics, stable identity, no missing glasses, no standing/detached baby, and no vehicle-body separation.

### Task 4: Build and validate all 16 look directions

**Files:**
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\qa\look-mechanics.md`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\decoded\look-anchors-approved.png`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\decoded\look-row-9.png`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\decoded\look-row-10.png`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\qa\direction-semantics.json`

**Interfaces:**
- Consumes: approved standard atlas, canonical base, permanent black-lensed sunglasses requirement, and fixed clockwise direction order.
- Produces: four approved cardinal anchors and two coherent eight-frame look rows with stable lower-body and vehicle registration.

- [ ] **Step 1: Define humanoid look mechanics**

Write `qa\look-mechanics.md`: motorcycle, seated lower body, and hands remain anchored; head and neck lead; sunglasses remain opaque black and follow the head; direction reads through head pitch/yaw, cheek/nose visibility, beanie orientation, and restrained upper-body follow-through rather than visible pupils or whole-sprite rotation.

- [ ] **Step 2: Generate and approve the four cardinals**

Generate `000 up`, `090 screen-right`, `180 down`, and `270 screen-left` together. Extract with `extract_cardinal_anchors.py`, inspect at final pet size, and compose `look-anchors-approved.png`. Any ambiguous cardinal must be regenerated before continuing.

- [ ] **Step 3: Generate and register row 9**

Generate the coherent sequence `000, 022.5, 045, 067.5, 090, 112.5, 135, 157.5`; run `assemble_extended_atlas.py` in registered-row mode and accept only stable scale, baseline, vehicle anchor, face, beanie, and sunglasses.

- [ ] **Step 4: Generate row 10 from the approved continuity evidence**

Attach the approved cardinal strip and completed row 9, then generate `180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5`. Reject any wrong cardinal, loop reversal, whole-sprite tilt, vehicle shift, or glasses removal.

- [ ] **Step 5: Record labeled direction semantics**

Create `qa\direction-semantics.json` with all 16 directions, each containing `verdict`, `expected`, `observed`, and `reason`. No `fail` verdict may remain.

### Task 5: Assemble, independently QA, package, and clean up

**Files:**
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\final\spritesheet-extended.webp`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\final\validation-extended.json`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\qa\contact-sheet-extended.png`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\qa\look-directions.png`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\qa\direction-blind-validation.json`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\qa\look-continuity.json`
- Create: `C:\Users\ADMIN\.codex\pets\baby-biker\spritesheet.webp`
- Create: `C:\Users\ADMIN\.codex\pets\baby-biker\pet.json`
- Create: `C:\Users\ADMIN\.codex\pet-runs\baby-biker\qa\run-summary.json`

**Interfaces:**
- Consumes: validated standard atlas, registered row 9, coherent row 10, run chroma key, and all QA evidence.
- Produces: one installed Codex v2 pet and retained QA artifacts.

- [ ] **Step 1: Assemble and despill exactly once**

Run `assemble_extended_atlas.py`, then one `despill_chroma_edges.py` pass using the run chroma key. Expected despill report: `ok: true`.

- [ ] **Step 2: Run deterministic v2 validation**

Run `validate_atlas.py --require-v2`. Expected: atlas dimensions `1536x2288`, valid `192x208` cells, non-empty used cells, transparent unused cells, and no opaque chroma-key failures.

- [ ] **Step 3: Produce visual QA artifacts**

Create the extended contact sheet, focused neutral-plus-16 direction sheet, blind A/B direction sheet, and continuity report with the corresponding `hatch-pet` scripts.

- [ ] **Step 4: Run isolated blind and final visual reviews**

Use exactly three isolated workers that inspect only the blind sheet; combine and validate their verdicts. Then use one independent final visual QA worker to inspect contact sheets, GIFs, semantics, continuity, and deterministic validation. Major failures block packaging; accepted minor warnings require `qa\blind-review-resolution.json`.

- [ ] **Step 5: Package the passing pet**

Copy the final WebP to `C:\Users\ADMIN\.codex\pets\baby-biker\spritesheet.webp` and create `pet.json` with id `baby-biker`, display name `Baby Biker`, the approved description, `spriteVersionNumber: 2`, and `spritesheetPath: "spritesheet.webp"`.

- [ ] **Step 6: Write the run summary and retain QA evidence**

Create `qa\run-summary.json` with `ok: true` and paths to the atlas, validation, despill, contact sheets, direction semantics, blind validation, continuity report, standard review, and installed package. Remove only disposable prompts, layout guides, generated strips, extracted frames, PNG intermediates, the 8x9 atlas, and completed job manifest after all retained outputs and the installed package are verified.

- [ ] **Step 7: Final acceptance check**

Inspect the retained contact sheet at normal pet size and verify every cell shows the same baby seated on the same three-wheel motorcycle with white-framed black-lensed sunglasses. Re-read `pet.json`, `validation-extended.json`, `chroma-despill-extended.json`, `direction-blind-validation.json`, `direction-semantics.json`, and `run-summary.json`; all required gates must pass before reporting completion.
