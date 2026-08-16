import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const packagesDir = join(root, "packages");
const ownersFile = join(root, "owners.json");

const repo = process.env.REPO ?? "";
if (!repo) {
	console.error("Missing required env: REPO");
	process.exit(1);
}

// Load current owners (numeric GitHub ids).
let owners: Record<string, number> = {};
try {
	owners = JSON.parse(readFileSync(ownersFile, "utf8"));
} catch {
	// no owners file yet
}

// Every package file without an owner entry is new since the last sync.
const packageNames = readdirSync(packagesDir)
	.filter((f) => f.endsWith(".json"))
	.map((f) => {
		try {
			return (JSON.parse(readFileSync(join(packagesDir, f), "utf8")) as { name?: string })
				.name;
		} catch {
			return undefined;
		}
	})
	.filter((n): n is string => typeof n === "string");

const missing = packageNames.filter((n) => !(n in owners));
if (missing.length === 0) {
	console.log("No new packages to record.");
	process.exit(0);
}

console.log(`Resolving owners for: ${missing.join(", ")}`);

for (const name of missing) {
	const relative = `packages/${name}.json`;

	// The commit that first added this file to master.
	const sha = (
		await $`git log --follow --diff-filter=A --format=%H -1 -- ${relative}`
			.nothrow()
			.quiet()
			.cwd(root)
			.text()
	)
		.trim();
	if (!sha) {
		console.error(`Could not find introducing commit for ${name}`);
		process.exit(1);
	}

	// Resolve the author's numeric GitHub id from the commit. Falls back to
	// the PR that introduced the commit when the commit author is not linked.
	let id = "";
	try {
		id = (
			await $`gh api repos/${repo}/commits/${sha} --jq .author.id`
				.nothrow()
				.quiet()
				.text()
		).trim();
	} catch {
		// fall through
	}
	if (!id || id === "null") {
		id = (
			await $`gh api repos/${repo}/commits/${sha}/pulls --jq '.[0].user.id'`
				.nothrow()
				.quiet()
				.text()
		).trim();
	}
	if (!id || id === "null") {
		console.error(
			`Could not resolve the GitHub id of the author of ${relative} (commit ${sha}). ` +
				`Record it manually in owners.json.`,
		);
		process.exit(1);
	}

	owners[name] = Number(id);
	console.log(`  ${name} -> ${id}`);
}

// Write back sorted, tab-indented like the rest of the repo.
const sorted: Record<string, number> = {};
for (const key of Object.keys(owners).sort()) {
	const value = owners[key];
	if (value !== undefined) sorted[key] = value;
}
writeFileSync(ownersFile, JSON.stringify(sorted, null, "\t") + "\n");

// Commit and push to master.
await $`git add owners.json`.cwd(root);
const committed = await $`git -c user.name="registry-bot" -c user.email="registry-bot@users.noreply.github.com" commit -m "Record owners for new packages"`
	.nothrow()
	.quiet()
	.cwd(root);
if (committed.exitCode !== 0) {
	console.error("Nothing to commit or commit failed");
	process.exit(0);
}

const token = process.env.GH_TOKEN ?? "";
const pushed = await $`git push https://x-access-token:${token}@github.com/${repo}.git HEAD:master`
	.nothrow()
	.quiet()
	.cwd(root);
if (pushed.exitCode !== 0) {
	console.error(
		"Push failed. The bot token needs contents:write on master (or branch protection must allow the bot).",
	);
	process.exit(1);
}
console.log("Pushed owners.json to master.");
