# LogBrew for VS Code

See the newest errors of your project next to your code. [LogBrew](https://logbrew.co) groups the errors, logs, and traces your apps send into issues you can act on, and you can start on the free plan with no card.

The extension works in VS Code, Cursor, Windsurf, VSCodium, and other editors that install extensions from the VS Code Marketplace or Open VSX.

## What you get

- **Issues.** The 50 unresolved issues of the project with the newest activity. Each row shows the level, the event count, and when the issue was last seen.
- **Errors.** The error and critical logs that the project sent in the last 24 hours.
- Click a row to open the issue or the trace in LogBrew. Right-click a row to copy its link.

## Install and sign in

1. Install **LogBrew** from the Extensions view, or run `code --install-extension logbrew.logbrew`.
2. Select the LogBrew mug in the Activity Bar.
3. Select **Sign In**. Your browser opens LogBrew and shows a code.
4. Make sure the code in the browser matches the code in the editor, then approve the sign-in.
5. The extension picks the project whose name matches the workspace folder. If none matches, select **Choose Project**.

You don't copy or paste a key. The extension keeps the session in the editor's encrypted storage. To sign out, open the **...** menu of the Issues view and select **Sign Out**.

## Settings

`logbrew.apiUrl`: keep `https://api.logbrew.co`. Change it only when your team runs LogBrew at another address. Only your user settings can change it, so a workspace cannot send your session to another server.

## Privacy

The extension reads issues and logs from the LogBrew API with your session. It sends no telemetry. From your workspace it reads only the folder names, to pick the project.
