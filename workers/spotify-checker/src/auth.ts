import * as arctic from 'arctic';
import { type Context, type Handler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import { saveUser } from './users';

export type AppHandler = Handler<{ Bindings: Env }>;

const SPOTIFY_SCOPES = ['user-follow-read'];
const DISCORD_SCOPES = ['identify'];
const OAUTH_MAX_AGE = 600;

interface PendingLink {
	spotifyUserId: string;
	refreshToken: string;
}

const cookieOptions = (c: Context<{ Bindings: Env }>) => ({
	path: '/',
	httpOnly: true,
	sameSite: 'Lax' as const,
	secure: new URL(c.req.url).protocol === 'https:',
	maxAge: OAUTH_MAX_AGE,
});

const origin = (c: Context<{ Bindings: Env }>): string => new URL(c.req.url).origin;

const spotifyClient = (c: Context<{ Bindings: Env }>): arctic.Spotify =>
	new arctic.Spotify(
		c.env.SPOTIFY_CLIENT_ID,
		c.env.SPOTIFY_CLIENT_SECRET,
		`${origin(c)}/auth/spotify/callback`,
	);

const discordClient = (c: Context<{ Bindings: Env }>): arctic.Discord =>
	new arctic.Discord(
		c.env.DISCORD_CLIENT_ID,
		c.env.DISCORD_CLIENT_SECRET,
		`${origin(c)}/auth/discord/callback`,
	);

export const linkRoute: AppHandler = (c) => {
	if (c.req.query('secret') !== c.env.LINK_SECRET) {
		return c.text('unauthorized', 401);
	}

	const state = arctic.generateState();
	const url = spotifyClient(c).createAuthorizationURL(state, null, SPOTIFY_SCOPES);
	url.searchParams.set('show_dialog', 'true');

	const opts = cookieOptions(c);
	setCookie(c, 'spotify_state', state, opts);
	deleteCookie(c, 'pending_link', opts);
	deleteCookie(c, 'discord_state', opts);

	return c.redirect(url.toString());
};

export const authSpotifyCallbackRoute: AppHandler = async (c) => {
	const code = c.req.query('code');
	const state = c.req.query('state');
	const savedState = getCookie(c, 'spotify_state');

	if (!code || !state || !savedState || state !== savedState) {
		return c.text('invalid spotify callback — start again at /link', 400);
	}

	let tokens: arctic.OAuth2Tokens;
	try {
		tokens = await spotifyClient(c).validateAuthorizationCode(code, null);
	} catch {
		return c.text('spotify authorization failed — start again at /link', 400);
	}

	const refreshToken = tokens.refreshToken();
	if (!refreshToken) {
		return c.text('no spotify refresh token — start again at /link', 400);
	}

	const me = await fetch('https://api.spotify.com/v1/me', {
		headers: { Authorization: `Bearer ${tokens.accessToken()}` },
	});
	if (!me.ok) {
		return c.text('failed to fetch spotify user — start again at /link', 400);
	}

	const { id: spotifyUserId } = (await me.json()) as { id: string };
	const pending: PendingLink = { spotifyUserId, refreshToken };

	const discordState = arctic.generateState();
	const discordUrl = discordClient(c).createAuthorizationURL(discordState, null, DISCORD_SCOPES);

	const opts = cookieOptions(c);
	deleteCookie(c, 'spotify_state', opts);
	setCookie(c, 'pending_link', JSON.stringify(pending), opts);
	setCookie(c, 'discord_state', discordState, opts);

	return c.redirect(discordUrl.toString());
};

export const authDiscordCallbackRoute: AppHandler = async (c) => {
	const code = c.req.query('code');
	const state = c.req.query('state');
	const savedState = getCookie(c, 'discord_state');
	const pendingRaw = getCookie(c, 'pending_link');

	if (!code || !state || !savedState || state !== savedState || !pendingRaw) {
		return c.text('invalid discord callback — start again at /link', 400);
	}

	let pending: PendingLink;
	try {
		pending = JSON.parse(pendingRaw) as PendingLink;
	} catch {
		return c.text('invalid pending link — start again at /link', 400);
	}

	let tokens: arctic.OAuth2Tokens;
	try {
		tokens = await discordClient(c).validateAuthorizationCode(code, null);
	} catch {
		return c.text('discord authorization failed — start again at /link', 400);
	}

	const me = await fetch('https://discord.com/api/users/@me', {
		headers: { Authorization: `Bearer ${tokens.accessToken()}` },
	});
	if (!me.ok) {
		return c.text('failed to fetch discord user — start again at /link', 400);
	}

	const { id: discordUserId } = (await me.json()) as { id: string };

	await saveUser(c.env.POSTED_ALBUMS, {
		spotifyUserId: pending.spotifyUserId,
		refreshToken: pending.refreshToken,
		discordUserId,
	});

	const opts = cookieOptions(c);
	deleteCookie(c, 'pending_link', opts);
	deleteCookie(c, 'discord_state', opts);

	return c.text('ok');
};
