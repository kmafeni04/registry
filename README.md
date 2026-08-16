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

## Example

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

### Validation

On creation of a package, the bot will ensure that your PR is valid by verifiying it fits the JSON schema, and that you aren't overwriting old versions.

If it fails, it will request changes with a list of errors.

If there are no errors, it will be approved, and wait pending a maintainer accepting creation of a package. This part is not automatic as to avoid abuse, name-squatting, etc.

### Ownership

If your PR is successfully approved, the bot will make note of you as the *owner* of the package. This means that any PRs you make touching the package in the future will be automatically approved and accepted.

It works based off your GitHub id, so there will be no conflicts if your username changes.

Repo admins bypass this check and can obviously modify packages at will.

### Rules enforced

1. **Schema**: every changed package JSON must validate against `schemas/registry.schema.json`, and the `name` field must match the filename.
2. **Ownership**: modifying or deleting an existing package requires the recorded owner or a repo admin. New packages are claimable by whoever submits them.
3. **Versions**: updates may not modify or remove existing versions. Exactly one new version must be added.
4. **`owners.json`**: only repo admins may edit it directly (it is normally maintained by the bot).
5. **New packages are never auto-merged.** The bot approves them and a maintainer merges manually; the owner is recorded on `master` right after the merge.

### Self Hosting

The workflows use `GITHUB_TOKEN` for reading, but approving, merging and pushing need a real user token. You must:

1. **Create a dedicated bot account** (e.g. `lde-bot`) and add it as a repository collaborator with **write access**. Using a separate account matters: GitHub does not allow a user to approve their own pull request, so if the token belongs to the same account that opened the PR, the approve step fails. (The workflows tolerate that failure gracefully — the comment still posts and updates still merge — but the review stamp will be missing.)
2. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) for the bot account (recommended), or a classic token with the `repo` scope.
   - Fine-grained: repository access = this repo, permissions = **Contents: Read and write**, **Pull requests: Read and write**.
3. Add it as an Actions secret named `REGISTRY_BOT_TOKEN` (Settings → Secrets and variables → Actions).

Without this secret, validation still runs, but the approve / request-changes / close / merge steps will fail.

Optional: `REGISTRY_BOT_NAME` and `REGISTRY_BOT_EMAIL` secrets override the author of the owners.json commit. By default the bot commits as the account behind `REGISTRY_BOT_TOKEN` (resolved from the token at runtime, using that account's noreply email so GitHub attributes the commit to it), falling back to `robolde` / `robolde@users.noreply.github.com`.
