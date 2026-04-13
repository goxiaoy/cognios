# CogniOS — AI-Native Memory Operating System
## Final Consolidated Product Requirements Document (PRD) - Local First

**Version:** 3.0 (Local First)
**Date:** 2026
**Status:** Finalized Design Foundation
**Visual Direction:** Editorial Precision

---

### 1. Executive Summary
CogniOS is a local-first, AI-native memory operating system that transforms fragmented digital life into a structured, navigable, and synthesized cognitive extension. It prioritizes data privacy and speed by processing everything locally. It moves beyond traditional storage by unifying data through a Local Virtual File System (VFS) and autonomously clustering it into **Topics**, serving as a persistent substrate for AI intelligence.

---

### 2. Core Vision & Principles
*   **Vision:** A persistent, local-first, event-driven system that converts user data into intelligence.
*   **Local-First:** All data remains on the device; processing and synthesis happen locally for maximum privacy and speed.
*   **Topics over Folders:** AI autonomously clusters memory nodes into semantic "Topics," eliminating manual organization.
*   **Intelligence-First:** AI is the primary interface; users interact with synthesized knowledge, not just raw files.
*   **Editorial Precision:** A high-end, structured aesthetic that reduces cognitive load through grid discipline and typography.

---

### 3. Visual Identity: "Editorial Precision"
*   **Palette:** Newsprint Off-White background (`#F9F9F8`), Pure White surfaces (`#FFFFFF`), Deep Charcoal text (`#1C1C1A`).
*   **Accents:** Vermilion (`#E34126`) for primary actions; Editorial Green (`#0F5B43`) for verification/success.
*   **Typography:** 
    *   *Headings:* Newsreader (Serif, Italicized for character).
    *   *Body:* Satoshi (Clean Sans-serif).
    *   *Data/Meta:* JetBrains Mono (Technical precision).
*   **Aesthetic:** 0px border radius, 1px hairline borders, zero drop shadows, generous whitespace.

---

### 4. Information Architecture & Screens

#### 4.1 Global Navigation (Sidebar)
*   **Home:** AI entry point. Features a personalized greeting and **Suggested Topics** for instant context switching.
*   **Chat:** Deep-dive conversational interface anchored to specific Topics and local files. Includes a persistent breadcrumb context bar.
*   **Explorer:** High-density Local VFS artifact viewer with breadcrumb navigation and tree-view hierarchy.
*   **Memory Timeline:** A chronological ledger of "Episode Cards." The sidebar here transforms into a **Topics Explorer**.

#### 4.2 Key Component: The Episode Card
Located in the Memory Timeline, these cards represent synthesized "cognitive episodes."
*   **Title:** AI-generated summary of the event.
*   **Summary:** Bulleted insights.
*   **Metadata:** AI-assigned **Topic Tags**, linked entities, and referenced local artifacts.

#### 4.3 Context Panel (Right Panel)
A global inspector that surfaces:
*   **Active Context:** Current Topic or Episode details.
*   **Related Memory:** Semantic links to other relevant Topics.
*   **Entities:** People, orgs, and concepts identified by AI.

---

### 5. Key User Flows
1.  **Autonomous Recall:** User lands on **Home**, selects a **Suggested Topic** (e.g., "Project Alpha"), and is immediately presented with the relevant local AI context.
2.  **Synthesis:** User enters **Chat** within a Topic; the AI references local memory nodes to provide high-fidelity answers.
3.  **Discovery:** User browses the **Memory Timeline**, filtering by **Topics** to see how a project or thought evolved over months.

---

### 6. Technical Foundation (Local VFS)
*   **Node Types:** Local Files, System Logs, Local Chat Threads.
*   **States:** Indexing -> Analyzed -> **Verified** (Green accent).
*   **Hierarchy:** Breadcrumb-driven navigation implemented globally across Explorer and Chat. No cloud synchronization indicators.