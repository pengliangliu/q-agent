# Security and privacy

This application controls local assistant sessions and can open local files. Its bridge is intended for the loopback interface of a trusted personal machine. Do not expose ports 8420 or 8421 to a public network.

Authentication stays with the installed assistant CLIs. Never submit authentication files, API keys, session transcripts, attachments, WebView2 profiles, local `windows.json` / `wsl.json`, database files or raw terminal screenshots in a pull request or issue.

Use the app's filtered diagnostic copy when reporting a connection problem, and review it before sharing. A minimal synthetic example is preferable to a real conversation. For a sensitive vulnerability, use the repository's private security reporting channel when available; do not place exploit credentials or private transcripts in a public issue.

Before publishing your own fork, scan both the selected working tree and the Git history for secrets and personal information. A `.gitignore` prevents many accidental additions but does not remove already tracked history.
