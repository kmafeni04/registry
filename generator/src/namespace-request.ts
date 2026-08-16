import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import { resolveIdentity } from "./identity";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const authorityFile = join(root, "authority.json");

const event = process.env.EVENT ?? ""; // "issues" | "issue_comment"
const repo = process.env.REPO ?? "";
const issueNumber = process.env.ISSUE_NUMBER ?? "";
const issueBody = process.env.ISSUE_BODY ?? "";
const issueAuthorId = process.env.ISSUE_AUTHOR_ID ?? "";
const issueAuthorLogin = process.env.ISSUE_AUTHOR_LOGIN ?? "";
const commentBody = process.env.COMMENT_BODY ?? "";
const commentAuthorLogin = process.env.COMMENT_AUTHOR_LOGIN ?? "";
const commentAssociation = process.env.COMMENT_AUTHOR_ASSOCIATION ?? "";

if (!repo || !issueNumber || !issueAuthorId) {
	console.error("Missing required env: REPO, ISSUE_NUMBER, ISSUE_AUTHOR_ID");
	process.exit(1);
}

// A namespace is the first segment of a package name: 3-128 chars, lowercase,
// starts with a letter, ends with a letter or digit, only [a-z0-9_-].
const NAMESPACE_RE = /^[a-z][a-z0-9_-]{1,}[a-z0-9]$/;
const MAX_NAMESPACE_LEN = 128;

// The request phrase the website (or a user) puts in the issue body:
// "/request-namespace <name>". Capture any token; validation happens below so
// invalid names get a clear error instead of being silently ignored.
const REQUEST_RE = /\/request-namespace\s+(\S+)/i;

interface Authority {
	namespaces: Record<string, number[]>;
	top: Record<string, number[]>;
}

function loadAuthority(): Authority {
	try {
		return JSON.parse(readFileSync(authorityFile, "utf8"));
	} catch {
		return { namespaces: {}, top: {} };
	}
}

// Anyone who can merge PRs is effectively a moderator for namespace approval.
async function isModerator(): Promise<boolean> {
	if (["OWNER", "COLLABORATOR"].includes(commentAssociation)) return true;
	if (commentAuthorLogin) {
		try {
			const perm = (
				await $`gh api repos/${repo}/collaborators/${commentAuthorLogin}/permission --jq .permission`
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

async function comment(body: string): Promise<void> {
	const file = join("/tmp", `ns-comment-${issueNumber}.md`);
	writeFileSync(file, body);
	await $`gh issue comment ${issueNumber} --body-file ${file}`.nothrow().quiet();
}

async function closeIssue(): Promise<void> {
	await $`gh issue close ${issueNumber}`.nothrow().quiet();
}

const match = issueBody.match(REQUEST_RE);
const requested = match?.[1] ?? "";

// ---- Initial issue: validate and ask for a moderator ----
if (event === "issues") {
	if (!requested) {
		// Not a namespace request; ignore.
		process.exit(0);
	}
	if (!NAMESPACE_RE.test(requested) || requested.length > MAX_NAMESPACE_LEN) {
		await comment(
			`\`${requested}\` is not a valid namespace name. Namespaces must be 3-128 characters, ` +
				"lowercase, start with a letter, end with a letter or digit, and contain only `a-z`, `0-9`, `_` and `-`.",
		);
		await closeIssue();
		process.exit(0);
	}
	if (requested in loadAuthority().namespaces) {
		await comment(`The namespace \`${requested}\` already exists, so it cannot be claimed.`);
		await closeIssue();
		process.exit(0);
	}
	await comment(
		`Namespace request for \`${requested}\` received. ` +
			"A repository moderator must approve it before it can be created.",
	);
	process.exit(0);
}

// ---- Comment: moderator approval ----
if (event === "issue_comment") {
	const approved =
		commentBody.toLowerCase().includes("!approve") ||
		(commentBody.includes("@robolde") && /approve/i.test(commentBody));
	if (!approved) process.exit(0);

	if (!(await isModerator())) {
		await comment("Only repository moderators can approve namespace requests.");
		process.exit(0);
	}
	if (!requested) {
		await comment("This issue is not a namespace request (missing `/request-namespace <name>`).");
		process.exit(0);
	}

	const authority = loadAuthority();
	if (requested in authority.namespaces) {
		await comment(`The namespace \`${requested}\` already exists, so it cannot be claimed.`);
		await closeIssue();
		process.exit(0);
	}

	// Create the namespace and assign ownership to the requester.
	authority.namespaces[requested] = [Number(issueAuthorId)];

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

	await $`git add authority.json`.cwd(root);
	const identity = await resolveIdentity();
	const committed = await $`git -c user.name=${identity.name} -c user.email=${identity.email} commit -m "Create namespace ${requested}"`
		.nothrow()
		.quiet()
		.cwd(root);
	if (committed.exitCode !== 0) {
		console.error("Nothing to commit or commit failed");
		process.exit(1);
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

	await comment(
		`The namespace \`${requested}\` has been created and ownership assigned to @${issueAuthorLogin} (id ${issueAuthorId}).`,
	);
	await closeIssue();
	process.exit(0);
}

console.error(`Unknown event: ${event}`);
process.exit(1);
