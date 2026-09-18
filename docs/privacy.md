# Data and privacy

Jewish Reels combines local media processing with optional model requests through OpenRouter. This page distinguishes what stays in the workspace from what a selected provider receives.

## Ordinary classification

The selected model receives an image region and the active visual instructions. The ordinary classification prompt does not include source URLs, local paths, catalog titles, biographies, prior human labels, or filenames as evidence. Text that is visible inside the image remains part of the pixels.

OpenRouter and the selected model provider process those requests under their own terms and privacy policies. Do not submit footage that you are not authorized to process through those services.

## Feedback learning

Rebuilding learned rules is a separate user action. It can send the saved evidence region, the prior visual claim, and the current confirmed or false label. Free-form feedback notes are included only when the user selects that option.

The operation changes editable prompt rules. It does not train or fine-tune the provider's model through this application.

## Saved-hit troubleshooting

Troubleshooting displays the number of deduplicated evidence images before a run. When started, it sends those saved image pixels to one selected reviewer and stores the returned cue, decision, explanation, and image mapping in a separate audit report.

Clearing troubleshooting deletes that audit's scores and checkpoint. It does not remove original verdicts, footage, contact sheets, or human feedback.

## Credentials

An OpenRouter key can remain in memory for one session, be supplied through `OPENROUTER_API_KEY`, or be encrypted by Electron for the current Windows account. The compatibility settings profile remains under `%AppData%\ReelSight` for installations created before the Jewish Reels rename.

An optional Scrapfly key follows the same boundary: it can remain in memory, come from `SCRAPFLY_API_KEY`, or be encrypted for the current Windows account. The renderer receives only configured/remembered status. The key is never written in plaintext to app settings, workspace logs, queue errors, receipts, or diagnostics.

When configured, Scrapfly receives only public `vimeo.com/footagefarm/videos/search:…` and numeric-video oEmbed URLs used to identify an exact Footage Farm screener. Jewish Reels does not send video bytes, source images, browser cookies, authorization headers, Footage Farm page contents, or arbitrary target URLs through Scrapfly. Scrapfly processes those metadata requests under its own terms and privacy policy.

Optional Footage Farm Vimeo access can use a signed-in Edge or Chrome profile or a Netscape cookies file. Settings retain only the selected browser/profile or the local cookies-file path. Jewish Reels does not copy, display, or log cookie values. The configured access is passed to yt-dlp only after the resolver has verified an exact reel-number and duration match on Footage Farm's official Vimeo account; it is never attached to arbitrary Vimeo or other media URLs.

Never place credentials or an exported cookies file in the repository, a workspace fixture, a screenshot, or a captured request log. If a credential is exposed, revoke it rather than relying on deletion of the visible text.

## Local workspace data

| Path | Purpose |
| --- | --- |
| `.pipeline/queue.sqlite` | Source collections, ownership, stage, and retry state. |
| `.pipeline/media/<id>/` | Downloaded or normalized source media. |
| `.pipeline/staging/<id>/` | Preparation work that is not yet published. |
| `.pipeline/receipts/<id>.json` | Coverage, timing, source identity, and provenance. |
| `frames/<id>/cards/card_*.jpg` | Published timestamped contact sheets. |
| `chat_verdicts.json` | Visual verdict ledger. |
| `reelsight_manifest.json` | Optional titles, URLs, and source-media mappings. |
| `logs/` | Review, usage, recovery, deferred-work, and preparation journals. |
| `reports/` | Exported or troubleshooting reports. |

These files can reveal source material, research interests, usage, or provider activity. Store the workspace in a location protected by the Windows account and exclude it from backups or synchronization services that are inappropriate for the material.

## Retention and cleanup

Generated media becomes eligible for automatic cleanup only after a complete no-hit verdict has matching source identity and coverage. Cleanup waits for in-flight work and preserves queue records, receipts, verdicts, and audit logs.

Hits, unfinished inputs, manual holds, and mismatched receipts are retained. Confirmed hits and explicit manual-review holds are reported separately from the working-storage allowance, and the application does not erase them merely to satisfy that configured limit. A separate real-drive free-space guard can still pause new preparation before the disk becomes critically full.

## Sharing diagnostics

Before sharing diagnostics, remove API keys, authorization headers, cookies, private URLs, local usernames, complete filesystem paths, source frames, model request bodies, and model responses containing private information. Reproduce with synthetic media whenever possible.

## Related documentation

- [Getting started](getting-started.md)
- [User guide](user-guide.md)
- [Classification and evidence](classification.md)
- [Architecture and workspace data](architecture.md)
