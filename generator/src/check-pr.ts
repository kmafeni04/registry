import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
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

// ---- Authority (from base ref only, never from the PR) ----
// namespaces: namespace name -> owner GitHub ids (all packages in the namespace
// are owned by its owner). top: flat package name -> owner GitHub ids.
interface Authority {
	namespaces: Record<string, number[]>;
	top: Record<string, number[]>;
}

let authority: Authority = { namespaces: {}, top: {} };
try {
	authority = JSON.parse(
		readFileSync(join(root, "authority.json"), "utf8"),
	);
} catch {
	// no authority.json on base yet
}

// Ownership of a package name: namespaced packages inherit the namespace
// owner, flat packages are looked up in `top`.
function ownersFor(name: string): number[] | undefined {
	if (name.includes("/")) {
		const ns = name.split("/")[0] ?? "";
		return authority.namespaces[ns];
	}
	return authority.top[name];
}

async function show(sha: string, path: string): Promise<string | null> {
	const res = await $`git show ${sha}:${path}`.nothrow().quiet().cwd(root);
	return res.exitCode === 0 ? res.stdout.toString() : null;
}

type Verdict = "close" | "request-changes" | "approve" | "approve-merge";

const issues: string[] = []; // close-level
const errors: string[] = []; // request-changes-level (schema)
let touchedAuthorityFile = false;
let hasNewPackage = false;
let hasModifiedPackage = false;

const admin = await isAdmin();

const diffOut = (
	await $`git diff --name-status ${baseSha}...${headSha} -- packages/ authority.json`
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

	if (path === "authority.json") {
		touchedAuthorityFile = true;
		if (!admin) {
			issues.push(
				"`authority.json` can only be modified by repository admins.",
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
		const name = pkg.name ?? "";
		const owners = ownersFor(name);
		if (owners == null || owners.length === 0) {
			issues.push(`\`${path}\`: package \`${name}\` has no recorded owner.`);
		} else if (!owners.includes(Number(authorId)) && !admin) {
			issues.push(
				`\`${path}\`: only the package owner (GitHub id ${owners.join(", ")}) or a repo admin may delete \`${name}\`.`,
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

	// Name must match the filename (packages/<name>.json, nested for namespaces).
	const name = typeof pkg.name === "string" ? pkg.name : null;
	if (name && `packages/${name}.json` !== path) {
		errors.push(
			`\`${path}\`: package \`name\` (\`${name}\`) must match the filename.`,
		);
	}
	// Defense-in-depth: names are used to build paths; never allow traversal.
	// The schema pattern covers the format, this guards the path itself.
	if (
		name &&
		(name.includes("..") ||
			name.startsWith("/") ||
			name.endsWith("/") ||
			name.split("/").some((segment) => segment === ""))
	) {
		errors.push(
			`\`${path}\`: package \`name\` (\`${name}\`) is not a valid package name.`,
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

	const owners = baseName ? ownersFor(baseName) : undefined;
	if (owners == null || owners.length === 0) {
		issues.push(
			`\`${path}\`: package \`${baseName}\` has no recorded owner; a repo admin needs to add it to authority.json.`,
		);
	} else if (!owners.includes(Number(authorId)) && !admin) {
		issues.push(
			`\`${path}\`: \`${baseName}\` is owned by GitHub id(s) ${owners.join(", ")}; only the owner or a repo admin may modify it (you are id ${authorId}).`,
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
else if (hasNewPackage || touchedAuthorityFile) verdict = "approve";
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
