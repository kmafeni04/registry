import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const packagesDir = join(root, "packages");
const authorityFile = join(root, "authority.json");

const repo = process.env.REPO ?? "";
if (!repo) {
	console.error("Missing required env: REPO");
	process.exit(1);
}

// namespaces: namespace name -> owner GitHub ids. top: flat package name ->
// owner GitHub ids. Namespaced packages are owned via their namespace.
interface Authority {
	namespaces: Record<string, number[]>;
	top: Record<string, number[]>;
}

// Load current authority (numeric GitHub ids).
let authority: Authority = { namespaces: {}, top: {} };
try {
	authority = JSON.parse(readFileSync(authorityFile, "utf8"));
} catch {
	// no authority file yet
}

function isCovered(name: string): boolean {
	if (name.includes("/")) {
		const ns = name.split("/")[0] ?? "";
		return ns in authority.namespaces;
	}
	return name in authority.top;
}

// Every package file without an owner entry is new since the last sync.
const packageNames = readdirSync(packagesDir, { recursive: true })
	.filter((f): f is string => typeof f === "string")
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

const missing = packageNames.filter((n) => !isCovered(n));
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
				`Record it manually in authority.json.`,
		);
		process.exit(1);
	}

	if (name.includes("/")) {
		const ns = name.split("/")[0] ?? "";
		authority.namespaces[ns] = [Number(id)];
		console.log(`  namespace ${ns} -> ${id}`);
	} else {
		authority.top[name] = [Number(id)];
		console.log(`  ${name} -> ${id}`);
	}
}

// Write back sorted, tab-indented like the rest of the repo.
const sorted: Authority = { namespaces: {}, top: {} };
for (const key of Object.keys(authority.namespaces).sort()) {
	const value = authority.namespaces[key];
	if (value !== undefined) sorted.namespaces[key] = value;
}
for (const key of Object.keys(authority.top).sort()) {
	const value = authority.top[key];
	if (value !== undefined) sorted.top[key] = value;
}
writeFileSync(authorityFile, JSON.stringify(sorted, null, "\t") + "\n");

// The bot's commit identity. Resolves the account behind the token so commits
// are attributed to it (using the account's noreply email). Can be overridden
// with BOT_NAME / BOT_EMAIL env vars (e.g. from repo secrets); falls back to
// "robolde" when neither the token nor the override is available.
async function resolveIdentity(): Promise<{ name: string; email: string }> {
	const envName = process.env.BOT_NAME?.trim();
	const envEmail = process.env.BOT_EMAIL?.trim();
	if (envName && envEmail) return { name: envName, email: envEmail };
	try {
		const out = await $`gh api user --jq '{login, id, name}'`
			.nothrow()
			.quiet()
			.text();
		const info = JSON.parse(out) as {
			login?: string;
			id?: number;
			name?: string | null;
		};
		if (info.login && info.id) {
			return {
				name: info.name?.trim() || info.login,
				email: `${info.id}+${info.login}@users.noreply.github.com`,
			};
		}
	} catch {
		// fall through to default
	}
	return { name: "robolde", email: "robolde@users.noreply.github.com" };
}

// Commit and push to master.
await $`git add authority.json`.cwd(root);
const identity = await resolveIdentity();
const committed = await $`git -c user.name=${identity.name} -c user.email=${identity.email} commit -m "Record owners for new packages"`
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
console.log("Pushed authority.json to master.");
