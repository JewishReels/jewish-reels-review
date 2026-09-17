# Classification and evidence

Jewish Reels reviews visible pixels against editable classification rules. It does not identify a person from their face, infer ancestry or religion, or turn catalog metadata into visual evidence.

## Visual criteria

Rules may cover visually resolvable cues such as Jewish ritual objects, Hebrew or Yiddish text, a kippah, tallit or tefillin, synagogue features, and defined forms of religious dress. The active policy also describes lookalikes and uncertainty boundaries. Rules can be enabled, disabled, rewritten, or extended in the application.

Historical context can help a human research a result after review, but a filename, title, biography, date, location, or assumed identity is not enough for a model hit. The response must point to qualifying pixels in the supplied image.

## Output requirements

A completed positive must:

1. name an allowed cue;
2. describe concrete visible evidence;
3. explain where that evidence appears; and
4. return a valid normalized bounding box around it.

A completed negative must use the explicit `none` cue and a null bounding box. Contradictory, malformed, refused, timed-out, or interrupted responses remain unfinished and are never silently converted into negative verdicts.

## Video-level decisions

A strict hit stops new requests for the video while already-sent requests can complete and be checkpointed. One video can retain several distinct matches.

A no-hit verdict requires complete coverage of every required card and image region. Changed source fingerprints, missing cards, receipt mismatches, provider failures, or unsafe journal writes prevent the final negative from being committed.

## Human feedback

Reviewers can save `confirmed_hit` or `false_hit` labels against exact evidence targets. Labels can be edited or undone. Bulk actions apply the same explicit decision to each selected target and remain individually traceable.

Feedback does not rewrite existing saved verdicts. It informs future or unfinished review only after learned rules are rebuilt.

## Learned rules

**Retrain from feedback** is rule synthesis rather than model training. The operation:

- reads the complete current feedback set without a fixed sample cap;
- sends the selected evidence and label through the chosen reviewer workflow;
- describes pixel-level distinctions between intended positives and lookalikes;
- merges entries only when direction and visual meaning agree;
- replaces previous learned entries while preserving manual rules; and
- creates a new compiled-policy fingerprint for subsequent review.

Because the policy fingerprint changes, unfinished work reuses saved regions only when the review configuration and source evidence still match.

## Troubleshooting review

Saved-hit troubleshooting is an independent audit. It deduplicates evidence by pixel hash, uses one selected reviewer, and stores the new decision separately from the main verdict ledger. The report includes every video occurrence that used the same saved pixels.

Titles, source URLs, prior labels, and old claims stay local during an ordinary troubleshooting request. Clearing the audit allows the same evidence to be scored again without changing the original verdict or human feedback.

## Related documentation

- [User guide](user-guide.md)
- [Data and privacy](privacy.md)
- [Architecture and workspace data](architecture.md)
