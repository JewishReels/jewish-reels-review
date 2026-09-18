# Getting started

Jewish Reels currently runs from source on Windows 10 or 11 x64. No supported installer or prebuilt download is published.

## Requirements

- Windows 10 or Windows 11 on x64
- Git
- Node.js 24 or newer with npm
- FFmpeg and FFprobe 9.0.1 from the Gyan essentials build
- yt-dlp 2026.08.19 Windows standalone executable
- An [OpenRouter](https://openrouter.ai/) API key for model-backed classification

Preparation can run without an OpenRouter key. Model-backed review, feedback learning, and saved-hit troubleshooting require one.

## Install the source

```powershell
git clone https://github.com/JewishReels/jewish-reels-review.git
cd jewish-reels-review
npm ci
npm test
```

The app expects the media executables in a sibling directory beside the repository:

```text
parent-directory/
├── jewish-reels-review/
└── package-resources/
    └── media-tools/
        ├── ffmpeg.exe
        ├── ffprobe.exe
        └── yt-dlp.exe
```

Use the versions and upstream sources recorded in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md). Do not commit these executables to the repository.

## Start the application

```powershell
npm start
```

Choose or create a workspace when prompted. Workspaces contain downloaded media, generated contact sheets, source receipts, checkpoints, verdicts, feedback, and reports. Keep them outside the repository.

## Configure model access

Open **Connection & settings** and enter an OpenRouter API key.

- With **Remember securely** disabled, the key remains in process memory for the current session.
- With **Remember securely** enabled, Electron encrypts the key for the current Windows account.
- The app also accepts the `OPENROUTER_API_KEY` environment variable.

Never add a key to source files, fixtures, screenshots, issues, or logs. Revoke a credential immediately if it is exposed.

For Footage Farm records that exist only on its official Vimeo account, the same settings screen can use a signed-in Edge or Chrome profile, or an exported Netscape cookies file. This is optional for ordinary Footage Farm progressive screeners. The app stores the selected profile or file path, not cookie contents, and uses it only after the Footage Farm account, reel number, and duration have been verified.

## First run

1. Select or create a source from the source control on the right side of the application.
2. Import a URL list or configure a supported website crawl.
3. Start preparation and wait for complete contact-sheet receipts.
4. Select a vision model and review settings.
5. Start visual review and inspect retained matches.
6. Confirm or reject results from the match-review screen.

Read the [User guide](user-guide.md) for the complete workflow and [Classification and evidence](classification.md) for the decision rules.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm start` | Run the Electron application from source. |
| `npm test` | Run the Node test suite with temporary workspaces and mocked providers. |
| `npm run screenshots` | Build the local demonstration screenshot fixtures. |
| `npm run package` | Build a local Windows x64 application folder. |

The packaging task requires the media-tool directory described above. It writes outside the repository, does not create an installer, and does not sign the application.

## Related documentation

- [User guide](user-guide.md)
- [Classification and evidence](classification.md)
- [Data and privacy](privacy.md)
- [Architecture and workspace data](architecture.md)
