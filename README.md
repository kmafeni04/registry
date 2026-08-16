# lde-org/registry

This repository contains the registry for LDE.

## How it works

The registry is just an easily indexable list of JSON files describing information for a package, and where to get it from.

No pre-built executables or library source code will be stored here.

## Contributing

You can use `lde publish` which will create a pull request with the changes to add your package to the registry.

Pull requests that touch `packages/**` are processed automatically by a bot (see [Automation](#automation)):

- New packages are validated against the schema and approved, but merged manually by a maintainer. The owner is recorded after merge.
- Updates to existing packages are auto-approved and auto-merged **only if** the author is the recorded package owner (or a repo admin) **and** the change adds exactly one new version without touching existing versions.
- Invalid JSON/schema → the bot requests changes with a list of errors.
- Non-owners touching an existing package → the PR is closed automatically.

### Example

```json
{
	"name": "hood",
	"description": "Cross-platform rendering in pure LuaJIT.",
	"authors": ["David Cruz <codebycruz@gmail.com>"],
	"git": "https://github.com/codebycruz/hood",
	"branch": "master",
	"versions": {
		"0.1.0": "5d4bb28703d8f1c17a0e241810145194a51042f0"
	}
}
```

## Automation

Two workflows + two scripts enforce ownership and validation:

| File | Purpose |
| --- | --- |
| `.github/workflows/check-pr.yml` | Runs on every PR touching `packages/**` or `owners.json`. Validates the schema, checks ownership, then approves / requests changes / closes / merges. |
| `.github/workflows/record-owners.yml` | Runs on every push to `master` touching `packages/**`. Resolves the GitHub id of the author of any new package and commits it to `owners.json`. |
| `generator/src/check-pr.ts` | The validation + ownership logic used by `check-pr.yml`. |
| `generator/src/record-owners.ts` | The post-merge owner resolution used by `record-owners.yml`. |

### Ownership (`owners.json`)

Every package maps to the **numeric GitHub user id** of its owner — never usernames, since usernames change (e.g. `codebycruz` no longer exists, but the account id is stable):

```json
{
	"cowsay": 268322015,
	"dotenv": 84547061,
	"hood": 86097860,
	"ssdg": 88457139,
	"sstream": 88457139,
	"targs": 88457139
}
```

- The id of a new package is resolved automatically from the commit that introduced it (`GET /repos/{owner}/{repo}/commits/{sha}` → `author.id`), falling back to the PR that contained it.
- To look up an id manually: `gh api users/<login> --jq .id`.
- Anyone with write access to this repository (repo admins, org members with write, collaborators) bypasses the ownership check — no admin list to maintain.

### Rules enforced

1. **Schema**: every changed package JSON must validate against `schemas/registry.schema.json`, and the `name` field must match the filename.
2. **Ownership**: modifying or deleting an existing package requires the recorded owner or a repo admin. New packages are claimable by whoever submits them.
3. **Versions**: updates may not modify or remove existing versions — exactly one new version must be added.
4. **`owners.json`**: only repo admins may edit it directly (it is normally maintained by the bot).
5. **New packages are never auto-merged.** The bot approves them and a maintainer merges manually; the owner is recorded on `master` right after the merge.

### Setting up the bot token

The workflows use `GITHUB_TOKEN` for reading, but approving, merging and pushing need a real user token. You must:

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) (recommended) for a dedicated bot account, or a classic token with the `repo` scope.
   - Fine-grained: repository access = this repo, permissions = **Contents: Read and write**, **Pull requests: Read and write**.
2. Add it as an Actions secret named `REGISTRY_BOT_TOKEN` (Settings → Secrets and variables → Actions).
3. The bot account needs **write access** to the repository (or admin, if you want it to bypass branch protection).

Without this secret, validation still runs, but the approve / request-changes / close / merge steps will fail.

### Self-hosting

If you run this on your own infrastructure:

- **Self-hosted runners**: the workflows run `bun` (via `oven-sh/setup-bun`) and the `gh` CLI. A self-hosted runner needs outbound access to GitHub's API and the npm registry (for `bun install`), and `gh` must be authenticated — the workflows set `GH_TOKEN` from the `REGISTRY_BOT_TOKEN` secret, so `gh` works out of the box. No other runner prerequisites.
- **GitHub Enterprise Server**: the API endpoints used (`repos/.../commits/...`) are the same. The fine-grained PAT must be created on your GHES instance, and the runner/`gh` need to target your GHES API host (`GH_HOST` / `GITHUB_API_URL`).
- **Branch protection (recommended)**: protect `master` and require the `Check PR` workflow to pass as a status check. Auto-merge (`gh pr merge --auto`) waits for the check to finish before merging, so this works even with required checks. Note that `record-owners.yml` pushes directly to `master`; if your branch protection blocks direct pushes, allow the bot's push or run it with admin bypass.
- **Ownership bootstrap**: `owners.json` was seeded from the git history of the existing packages. Verify the ids match the real maintainers (especially packages whose entries were submitted by a different account than the package author — e.g. `cowsay` was added by `lunar-ambassador`, `dotenv` by `ItzPancakse`). Fix any entry by editing `owners.json` (admin only).
