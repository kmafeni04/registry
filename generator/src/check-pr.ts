import { readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");

const baseSha = process.env.BASE_SHA ?? "";
const headSha = process.env.HEAD_SHA ?? "";
const authorId = process.env.PR_AUTHOR_ID ?? "";
const login = process.env.PR_AUTHOR_LOGIN ?? "";
const association = process.env.PR_AUTHOR_ASSOCIATION ?? "";
const repo = process.env.REPO ?? "";

if (!baseSha || !headSha || !authorId || !repo) {
	console.error(
		"Missing required env: BASE_SHA, HEAD_SHA, PR_AUTHOR_ID, REPO",
	);
	process.exit(1);
}

// Anyone who can merge PRs is effectively an admin for ownership purposes.
// author_association is computed by GitHub at event time; for org members we
// additionally verify the actual repo permission (MEMBER != write access).
async function isAdmin(): Promise<boolean> {
	if (["OWNER", "COLLABORATOR"].includes(association)) return true;
	if (login) {
		try {
			const perm = (
				await $`gh api repos/${repo}/collaborators/${login}/permission --jq .permission`
					.nothrow()
					.quiet()
					.text()
			).trim();
			if (perm === "admin" || perm === "write") return true;
		} catch {
			// fall through
		}
	}
	return false;
}

// ---- Schema ----
const schema = JSON.parse(
	readFileSync(join(root, "schemas", "registry.schema.json"), "utf8"),
);
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

interface PackageJson {
	name?: string;
	versions?: Record<string, string>;
}

// ---- Owners (from base ref only, never from the PR) ----
let owners: Record<string, number> = {};
try {
	owners = JSON.parse(
		readFileSync(join(root, "owners.json"), "utf8"),
	);
} catch {
	// no owners.json on base yet
}

async function show(sha: string, path: string): Promise<string | null> {
	const res = await $`git show ${sha}:${path}`.nothrow().quiet().cwd(root);
	return res.exitCode === 0 ? res.stdout.toString() : null;
}

type Verdict = "close" | "request-changes" | "approve" | "approve-merge";

const issues: string[] = []; // close-level
const errors: string[] = []; // request-changes-level (schema)
let touchedOwnersFile = false;
let hasNewPackage = false;
let hasModifiedPackage = false;

const admin = await isAdmin();

const diffOut = (
	await $`git diff --name-status ${baseSha}...${headSha} -- packages/ owners.json`
		.cwd(root)
		.text()
)
	.trim()
	.split("\n")
	.filter(Boolean);

interface Change {
	status: string;
	path: string;
}

const changes: Change[] = [];
for (const line of diffOut) {
	const [status, ...rest] = line.split("\t");
	if (!status) continue;
	// Renames: "R100\told\tnew"
	if (status.startsWith("R")) {
		const newPath = rest[1];
		if (newPath) changes.push({ status: "D", path: rest[0] ?? "" }, { status: "A", path: newPath });
	} else {
		const path = rest[0] ?? "";
		if (path) changes.push({ status, path });
	}
}

for (const change of changes) {
	const { status, path } = change;

	if (path === "owners.json") {
		touchedOwnersFile = true;
		if (!admin) {
			issues.push(
				"`owners.json` can only be modified by repository admins.",
			);
		}
		continue;
	}

	if (!path.startsWith("packages/") || !path.endsWith(".json")) continue;

	const baseContent = status === "A" ? null : await show(baseSha, path);
	const headContent = status === "D" ? null : await show(headSha, path);

	// Deletions: owner or admin only.
	if (status === "D") {
		if (!baseContent) continue;
		let pkg: PackageJson;
		try {
			pkg = JSON.parse(baseContent) as PackageJson;
		} catch {
			continue;
		}
		const owner = pkg.name ? owners[pkg.name] : undefined;
		if (owner == null) {
			issues.push(`\`${path}\`: package \`${pkg.name}\` has no recorded owner.`);
		} else if (owner !== Number(authorId) && !admin) {
			issues.push(
				`\`${path}\`: only the package owner (GitHub id ${owner}) or a repo admin may delete \`${pkg.name}\`.`,
			);
		}
		continue;
	}

	if (!headContent) continue;

	let pkg: PackageJson;
	try {
		pkg = JSON.parse(headContent) as PackageJson;
	} catch (e) {
		errors.push(`\`${path}\`: invalid JSON (${(e as Error).message})`);
		continue;
	}

	// Schema validation.
	if (!validate(pkg)) {
		for (const err of validate.errors ?? []) {
			const where = err.instancePath || "/";
			const params = err.params && Object.keys(err.params).length
				? ` (${JSON.stringify(err.params)})`
				: "";
			errors.push(`\`${path}\`${where}: ${err.message}${params}`);
		}
	}

	// Name must match the filename.
	const name = typeof pkg.name === "string" ? pkg.name : null;
	if (name && basename(path, ".json") !== name) {
		errors.push(
			`\`${path}\`: package \`name\` (\`${name}\`) must match the filename.`,
		);
	}

	// New package: claimable by the author (recorded after merge).
	if (status === "A") {
		hasNewPackage = true;
		continue;
	}

	// Existing package: ownership + version rules.
	hasModifiedPackage = true;

	const basePkg: PackageJson | null = baseContent
		? (JSON.parse(baseContent) as PackageJson)
		: null;
	if (!basePkg) continue;

	const baseName = typeof basePkg.name === "string" ? basePkg.name : null;
	if (baseName && baseName !== name) {
		issues.push(
			`\`${path}\`: package cannot be renamed (\`${baseName}\` -> \`${name}\`).`,
		);
	}

	const owner = baseName ? owners[baseName] : undefined;
	if (owner == null) {
		issues.push(
			`\`${path}\`: package \`${baseName}\` has no recorded owner; a repo admin needs to add it to owners.json.`,
		);
	} else if (owner !== Number(authorId) && !admin) {
		issues.push(
			`\`${path}\`: \`${baseName}\` is owned by GitHub id ${owner}; only the owner or a repo admin may modify it (you are id ${authorId}).`,
		);
	}

	// Version rule: base versions must be untouched, exactly one new version.
	const baseVersions = (basePkg.versions ?? {}) as Record<string, string>;
	const headVersions = (pkg.versions ?? {}) as Record<string, string>;

	const overridden = Object.entries(baseVersions).filter(
		([v, hash]) => headVersions[v] !== hash,
	);
	const added = Object.keys(headVersions).filter((v) => !(v in baseVersions));

	if (overridden.length > 0) {
		issues.push(
			`\`${path}\`: existing versions must not be modified or removed (${overridden
				.map(([v]) => `\`${v}\``)
				.join(", ")}).`,
		);
	}
	if (added.length !== 1) {
		issues.push(
			`\`${path}\`: updates must add exactly one new version (found ${added.length}).`,
		);
	}
}

let verdict: Verdict;
if (issues.length > 0) verdict = "close";
else if (errors.length > 0) verdict = "request-changes";
else if (hasNewPackage || touchedOwnersFile) verdict = "approve";
else if (hasModifiedPackage) verdict = "approve-merge";
else verdict = "approve";

const comment: string[] = [];
if (verdict === "close") {
	comment.push("This pull request was closed automatically.");
	comment.push("");
	comment.push("**Reasons:**");
	for (const issue of issues) comment.push(`- ${issue}`);
	comment.push("");
	comment.push("Only the recorded package owner (or a repo admin) may modify an existing package.");
} else if (verdict === "request-changes") {
	comment.push("This pull request needs changes before it can be merged.");
	comment.push("");
	comment.push("**Errors:**");
	for (const error of errors) comment.push(`- ${error}`);
} else if (verdict === "approve") {
	comment.push("Package validated. A maintainer will review and merge this PR; ownership is recorded after merge.");
} else {
	comment.push("Package update validated. Approved and merged automatically.");
}

console.log(JSON.stringify({ verdict, comment: comment.join("\n"), issues, errors }));
