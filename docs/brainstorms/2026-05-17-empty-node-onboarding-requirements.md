---
date: 2026-05-17
topic: empty-node-onboarding
---

# Empty Node Onboarding

## Summary

When the user's node list is empty, CogniOS will show a non-blocking Home launchpad that helps them create their first content through Mount Folder, New Note, or Voice Note. Once content exists, onboarding shifts from "add content" to capability prompts such as configuring a Chat provider or enabling Advanced OCR when the user's content would benefit from it.

---

## Problem Frame

Home currently behaves like an observability dashboard. For an established user, that is useful: it shows indexing volume, in-flight jobs, latency, and token usage. For a user with no nodes, the same surface collapses into empty metrics and blank charts. That first impression does not explain what to do next, and it makes CogniOS feel inert before the user has created the memory substrate the product depends on.

The first-run problem is not that the user needs a tutorial. They need a quick, reversible way to put something into CogniOS without being blocked from exploring the rest of the app. The onboarding should therefore be state-driven and non-blocking: it appears when there is no content to work with, disappears once content exists, and never prevents direct access to Explorer, Settings, Chat, Search, or Voice Note.

---

## Actors

- A1. New or empty-workspace user: Needs a clear first action without reading documentation or configuring the whole system upfront.
- A2. Returning user with an empty node list: May have deleted content or started over and needs the same recovery path.
- A3. CogniOS app shell: Detects empty content state and routes users to the right existing creation/configuration flows.
- A4. Search/model subsystem: Provides readiness and content-type signals that can make later prompts relevant.

---

## Key Flows

- F1. Empty node launchpad
  - **Trigger:** The app opens Home and the node list is empty.
  - **Actors:** A1, A2, A3
  - **Steps:** Home replaces empty metrics with a launchpad; the user can mount a folder, create a note, or start a Voice Note; the user can also ignore the launchpad and navigate elsewhere.
  - **Outcome:** The user has obvious first-content actions without being blocked.
  - **Covered by:** R1, R2, R3, R4, R5

- F2. First content created
  - **Trigger:** The node list changes from empty to non-empty.
  - **Actors:** A1, A2, A3
  - **Steps:** Home stops treating onboarding as the primary surface; normal dashboard content can appear; lightweight next-step prompts may remain available.
  - **Outcome:** Onboarding gets out of the way once CogniOS has content.
  - **Covered by:** R1, R6, R7

- F3. Chat provider prompt
  - **Trigger:** The user has at least one node but Chat has no usable provider configured or ready.
  - **Actors:** A1, A3
  - **Steps:** Home or Chat shows a non-blocking prompt to configure or verify a Chat provider; users can dismiss or continue using non-chat features.
  - **Outcome:** The user understands why Chat is limited and where to fix it.
  - **Covered by:** R8, R9

- F4. Advanced OCR prompt
  - **Trigger:** The user has mounted or created content that includes image/PDF-like material that could benefit from Advanced OCR.
  - **Actors:** A1, A3, A4
  - **Steps:** CogniOS shows a targeted prompt explaining that Advanced OCR can improve extraction for relevant documents; the prompt is not shown when no relevant content exists.
  - **Outcome:** Expensive or slow enrichment is suggested only when it is likely to matter.
  - **Covered by:** R10, R11, R12

---

## Requirements

**Empty node launchpad**

- R1. Onboarding must be triggered by an empty node list, not by a generic first-run flag alone.
- R2. When the node list is empty, Home must present a launchpad instead of empty dashboard charts as the primary content.
- R3. The launchpad must offer three first-content actions: Mount Folder, Create Note, and Start Voice Note.
- R4. The launchpad must be non-blocking: users can still navigate to Explorer, Chat, Settings, Search, Voice Note, and other app areas.
- R5. The launchpad copy must frame actions around creating local content, not around completing setup.

**State transitions**

- R6. Once the node list is non-empty, Home should return to the normal dashboard as the primary surface.
- R7. Any remaining onboarding after content exists must be secondary and dismissible, not the main Home layout.

**Provider readiness**

- R8. Chat provider setup must be prompted after content exists, not as a prerequisite to creating the first node.
- R9. If Chat is unavailable because no provider is configured or ready, the prompt must explain the limitation and provide a path to provider setup or verification.

**Advanced OCR**

- R10. Advanced OCR should be suggested only when the workspace contains content likely to benefit from it, such as images, PDFs, or scan-like documents.
- R11. Advanced OCR prompting must make the trade-off clear: better extraction for eligible files, with additional model/download/indexing cost.
- R12. Advanced OCR must remain optional; dismissing or ignoring the prompt must not block indexing, search, note creation, folder mounting, or chat setup.

**Contextual empty states**

- R13. Explorer, Chat, and Search may each show lightweight contextual empty states, but these must support the Home launchpad rather than becoming separate onboarding flows.
- R14. Search and Chat should not be presented as primary first actions while the node list is empty, because there is no local content to search or ground answers against.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3, R4.** Given the node list is empty, when the user opens Home, they see Mount Folder, Create Note, and Start Voice Note actions while the rest of the app remains navigable.
- AE2. **Covers R6, R7.** Given the user creates their first note, when Home refreshes, the empty-node launchpad no longer dominates the page.
- AE3. **Covers R8, R9.** Given the user has nodes but no usable Chat provider, when they open Home or Chat, they see a non-blocking provider setup prompt instead of a generic empty chat surface.
- AE4. **Covers R10, R11, R12.** Given the user mounts a folder containing PDFs or images, when CogniOS detects those content types, it may suggest Advanced OCR with its cost trade-off, and the user can dismiss it without losing normal app functionality.
- AE5. **Covers R13, R14.** Given the node list is empty, when the user opens Search, the empty state points back to adding content rather than implying search is broken.

---

## Success Criteria

- A user with an empty workspace can identify a useful first action within a few seconds of landing on Home.
- The user can add first content without completing provider setup, model setup, or Advanced OCR setup.
- Once content exists, onboarding becomes a secondary guide rather than a permanent first-screen replacement.
- Chat provider and Advanced OCR prompts appear only when they are contextually useful.
- A planner can proceed without inventing the trigger condition, first actions, non-blocking behavior, or sequencing between content creation and capability setup.

---

## Scope Boundaries

- No blocking onboarding wizard.
- No multi-page tutorial flow.
- No requirement that users configure Chat provider before creating content.
- No requirement that users enable Advanced OCR before mounting folders or indexing basic content.
- No persistent achievement/checklist system beyond what is needed for the empty-node and secondary prompt states.
- No broad redesign of Home's established observability dashboard for non-empty workspaces.
- No promise that Chat or Search will be useful before local nodes exist.

---

## Key Decisions

- Empty node list is the trigger: this keeps onboarding tied to observable product state instead of a brittle first-run flag.
- First content actions are plural: Mount Folder, Create Note, and Voice Note cover imported, written, and captured memories.
- Capability setup is sequenced after content creation: provider and OCR prompts are more meaningful once the user has something to use them with.
- Advanced OCR is contextual: it should appear as an enhancement for relevant content, not as a universal setup step.
- Onboarding remains non-blocking: CogniOS should feel usable immediately, even when it is guiding the user.

---

## Dependencies / Assumptions

- The app can reliably know whether the current explorer node list is empty.
- CogniOS can distinguish at least broad content categories after mounting or indexing begins, enough to know whether images/PDFs are present.
- Existing Mount Folder, Create Note, Voice Note, Chat provider setup, and Advanced OCR setup flows can be linked from onboarding surfaces.
- Existing model/download status surfaces remain available for detailed progress; onboarding only needs to point to them.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R10][Technical] What signal should trigger the Advanced OCR prompt: mounted file extensions, indexed processor needs, failed/basic OCR quality, or a combination?
- [Affects R8-R9][Technical] What exact provider states count as "Chat unavailable" versus "configured but warming up"?
- [Affects R7][Product/UI] Should users be able to manually dismiss all secondary onboarding prompts, or should some return when relevant state changes?
