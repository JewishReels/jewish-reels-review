# User guide

Jewish Reels separates footage preparation from model-backed visual review. Preparation resolves and samples footage locally. Review consumes only complete contact sheets and records evidence for later human inspection.

## Choose a source

The source selector limits the active pipeline to one collection without deleting other queues. A source may come from:

- the Footage Farm catalog crawler;
- the generic same-site crawler;
- a text, CSV, or JSON list of URLs;
- a supported queue database; or
- records previously imported into the workspace.

Crawler boundaries should stay on the selected website. Review the discovered URLs before starting a large preparation run. Source titles and URLs remain local metadata and do not enter ordinary classification prompts.

## Prepare footage

Preparation resolves playable media, downloads or normalizes it, probes timing, samples frames, builds timestamped contact sheets, validates coverage, and then publishes the finished card set atomically.

Fixed sampling captures one frame per second. Adaptive modes may examine more candidates and retain additional frames only when they differ materially. Prepared cards contain whole frames; large cards can later be split into overlapping review regions so visible detail remains legible.

A card set does not become reviewable until its receipt proves complete coverage. Preparation can continue independently while model review is paused or disconnected.

## Run visual review

Choose the active source, model, request mode, worker ceiling, simultaneous-video ceiling, and run budget. The worker value is a global request ceiling. The simultaneous-video setting controls how many videos share that capacity.

Completed image regions are checkpointed. Pausing, restarting, a temporary connection failure, or a provider cooldown does not discard saved work. A confirmed visual hit stops unsent regions for that video while requests already in flight can finish and be saved.

A no-hit result is written only after every required card and region completes successfully. Refusals, malformed responses, timeouts, changed source files, and missing inputs remain unfinished or move to manual attention.

## Review matches

Each match retains the cue, explanation, evidence location, normalized bounding box, source card, model, and review configuration. Open the evidence viewer to zoom, drag, and compare the highlighted region with the complete saved image.

Videos can contain more than one match. Use the per-video controls to cycle through that video's hits or the broader controls to move through every retained match.

## Confirm or reject results

Use individual review actions for close inspection or bulk review for a page of obvious results. A label is attached to the exact evidence target and can be edited or removed later.

**Retrain from feedback** does not alter model weights. It reads the complete current confirmed and false label set, asks the selected reviewer to describe observable distinctions, merges only lessons that agree in direction and visual meaning, and replaces the learned entries in the editable Classification rules. Manual rules remain editable and are preserved.

## Troubleshoot saved hits

The troubleshooting screen extracts exact saved evidence images, hashes their pixels, and removes duplicate images before sending them. It uses one selected reviewer and displays the returned decision, cue, explanation, image, and all video occurrences that share those pixels.

Clearing troubleshooting removes only its scores and checkpoints. It does not delete footage, cards, verdicts, or human feedback. A rerun starts from the saved evidence again.

## Storage and cleanup

The storage limit covers managed downloads, staging files, and cards. A downloaded source video is temporary: after complete cards are published, Jewish Reels records the source identity plus a signature of those exact card bytes, then deletes the source. Review verifies that signature before trusting the saved source identity. A hit retains only its evidence/contact-sheet card set; a complete no-hit deletes its generated cards after the verdict and coverage receipt agree. Queue rows, receipts, verdicts, and audit logs remain.

Hit cards, unfinished cards, and manual-hold cards remain available for inspection and can fill the configured storage allowance. They require deliberate review or archiving; the storage guard and **Clean up media** button do not erase durable cards automatically.

## Diagnose a problem

Start with the live status and event history in the application, then review [Architecture and workspace data](architecture.md) for failure semantics and [Data and privacy](privacy.md) before sharing any diagnostic material. Preserve the workspace until the relevant queue row, receipt, checkpoint, and verdict have been inspected.

## Related documentation

- [Getting started](getting-started.md)
- [Classification and evidence](classification.md)
- [Data and privacy](privacy.md)
- [Architecture and workspace data](architecture.md)
