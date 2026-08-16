import { $ } from "bun";

// The bot's commit identity. Resolves the account behind the token so commits
// are attributed to it (using the account's noreply email). Can be overridden
// with BOT_NAME / BOT_EMAIL env vars (e.g. from repo secrets); falls back to
// "robolde" when neither the token nor the override is available.
export async function resolveIdentity(): Promise<{ name: string; email: string }> {
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
