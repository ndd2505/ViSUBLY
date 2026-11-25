# Global Codex Notes

## Response Language

- Always respond to the user in Vietnamese, regardless of the language used in the request.
- Keep this rule persistent for all future work in this workspace.

## Active Project Path

- The real project for this workspace is `D:\Projects\ViSUBLY`.
- Treat `D:\Projects\ViSUBLY` as the default working directory for scans, code edits, git commands, tests, and app runs, even if the thread environment reports `C:\Users\ADMIN\Documents\New project` as `cwd`.
- Prefer explicit command working directories, for example `workdir: D:\Projects\ViSUBLY` and `git -C "D:\Projects\ViSUBLY" ...`.

## Build After Changes

- After completing code changes in this project, build the latest Windows app package so the user can check it.
- Use `npm.cmd run package:win` from `D:\Projects\ViSUBLY` unless the user asks for a different build target.
- If an existing ViSUBLY app instance is open or blocks packaging, it is okay to terminate that ViSUBLY app process before building.
- Only terminate processes that are clearly part of this project/app.
