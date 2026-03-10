---
description: Sync global workflows into project — re-copies latest versions from global config
---
// turbo-all

# /sync-globals

Re-syncs global Antigravity workflows into this project's `.agents/workflows/` directory.

## Usage
```
/sync-globals
```

## Agent Instructions

Run the sync script from the project root:

```powershell
powershell -ExecutionPolicy Bypass -File .agents/scripts/sync-global-workflows.ps1
```

After syncing, verify the files have proper YAML frontmatter (`---` / `description:` / `---`).
If any synced file is missing frontmatter, add it — the system needs it for slash command discovery.

### Post-sync checklist:
1. Run the sync script
2. Review output for any warnings
3. Verify frontmatter on all synced files
4. If any files were updated, note the changes for the user

### What gets synced:
| File | Slash Command | Notes |
|---|---|---|
| `github.md` | `/github` | Git workflow |
| `debug-fix.md` | `/debug-fix` | Fix sub-agent |
| `plan-fix.md` | `/plan-fix` | Pre-flight planner |
| `test-fix-loop.md` | `/test-fix-loop` | Test loop rules |
| `test-loop.md` | `/test-loop` | Self-healing loop |

### What does NOT get synced:
- `migration.md` — project has a customized version with ARIA-specific connection details

### Adding new global workflows:
1. Create the workflow in `~/.gemini/antigravity/global_workflows/`
2. Add the filename to the `$WorkflowFiles` array in `.agents/scripts/sync-global-workflows.ps1`
3. Run `/sync-globals`
