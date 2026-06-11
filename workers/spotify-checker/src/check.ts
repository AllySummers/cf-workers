/// <reference types="spotify-api" />

import * as arctic from 'arctic';
import pLimit from 'p-limit';
import pRetry, { AbortError, type RetryContext } from 'p-retry';
import pThrottle from 'p-throttle';

import { listUsers, type User } from './users';

// Number of recent albums to fetch per artist.
const ALBUMS_PER_ARTIST = 5;

// Cap Spotify API usage: at most N requests per rolling window.
const SPOTIFY_MAX_REQUESTS = 5;
const SPOTIFY_RATE_WINDOW_MS = 1_000;
const SPOTIFY_CONCURRENCY = 3;

// Discord channel limit: 5 webhook posts per 5 seconds (shared per channel).
const DISCORD_MAX_REQUESTS = 30;
const DISCORD_RATE_WINDOW_MS = 5_000;

const MAX_FETCH_RETRIES = 5;

const DISCORD_EMBED_COLOR = 2_326_507;
const SPOTIFY_FOOTER_ICON =
	'https://storage.googleapis.com/pr-newsroom-wp/1/2023/05/Spotify_Primary_Logo_RGB_Green.png';

const artistKey = (artistId: string): string => `artist:${artistId}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const spotifyRetryAfterMs = (response: Response): number | undefined => {
	const header = response.headers.get('Retry-After');
	if (!header) return undefined;

	const seconds = Number(header);
	if (!Number.isNaN(seconds)) return seconds * 1_000;

	const date = Date.parse(header);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
};

const discordRetryAfterMs = async (response: Response): Promise<number | undefined> => {
	try {
		const body = (await response.clone().json()) as { retry_after?: number };
		if (typeof body.retry_after === 'number') {
			return Math.ceil(body.retry_after * 1_000);
		}
	} catch {
		// ignore non-JSON bodies
	}

	const header = response.headers.get('Retry-After');
	if (!header) return undefined;

	const value = Number(header);
	if (!Number.isNaN(value)) {
		// Legacy /api/webhooks URLs send Retry-After in milliseconds, not seconds.
		return value;
	}

	const date = Date.parse(header);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
};

const fetchWithRetry = async (
	url: string | URL,
	init: RequestInit | undefined,
	context: string,
	getRetryAfterMs: (response: Response) => number | undefined | Promise<number | undefined>,
): Promise<Response> => {
	return pRetry(
		async () => {
			const response = await fetch(url, init);

			if (response.status === 429 || response.status >= 500) {
				const wait = await getRetryAfterMs(response);
				if (wait !== undefined) {
					console.warn(`${context}: waiting ${wait}ms before retry`);
					await sleep(wait);
				}
				throw new Error(`${context} failed: ${response.status} ${response.statusText}`);
			}

			if (!response.ok) {
				throw new AbortError(`${context} failed: ${response.status} ${response.statusText}`);
			}

			return response;
		},
		{
			retries: MAX_FETCH_RETRIES,
			minTimeout: 1_000,
			maxTimeout: 30_000,
			factor: 2,
			onFailedAttempt: ({ attemptNumber, retriesLeft, error }: RetryContext) => {
				console.warn(`${context} attempt ${attemptNumber} failed (${retriesLeft} retries left): ${error.message}`);
			},
		},
	);
};

const fetchOk = (url: string | URL, init?: RequestInit, context?: string): Promise<Response> =>
	fetchWithRetry(url, init, context ?? 'Request', spotifyRetryAfterMs);

const discordFetchOk = (url: string | URL, init: RequestInit, context: string): Promise<Response> =>
	fetchWithRetry(url, init, context, discordRetryAfterMs);

const fetchJson = async <T>(url: string | URL, init?: RequestInit, context?: string): Promise<T> => {
	return (await fetchOk(url, init, context)).json() as Promise<T>;
};

const spotifyFetchJson = pThrottle({
	limit: SPOTIFY_MAX_REQUESTS,
	interval: SPOTIFY_RATE_WINDOW_MS,
	onDelay: () => {
		console.log(`Spotify rate limit reached (${SPOTIFY_MAX_REQUESTS}/${SPOTIFY_RATE_WINDOW_MS}ms), queuing request`);
	},
})(async <T>(url: string | URL, init: RequestInit, context: string): Promise<T> =>
	fetchJson<T>(url, init, context));

const spotifyRefreshClient = (env: Env): arctic.Spotify =>
	new arctic.Spotify(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET, 'https://localhost/auth/spotify/callback');

const refreshSpotifyAccessToken = async (env: Env, refreshToken: string): Promise<string> => {
	const tokens = await spotifyRefreshClient(env).refreshAccessToken(refreshToken);
	console.log('Spotify access token refreshed');
	return tokens.accessToken();
};

const getFollowedArtists = async (accessToken: string): Promise<SpotifyApi.ArtistObjectFull[]> => {
	const artists: SpotifyApi.ArtistObjectFull[] = [];
	let url: string | null = 'https://api.spotify.com/v1/me/following?type=artist&limit=50';
	let page = 0;

	while (url !== null) {
		page++;
		const data: SpotifyApi.UsersFollowedArtistsResponse = await spotifyFetchJson(
			url,
			{ headers: { Authorization: `Bearer ${accessToken}` } },
			'Failed to fetch followed artists',
		);

		artists.push(...data.artists.items);
		url = data.artists.next;
	}

	console.log(`Fetched ${artists.length} followed artist(s) across ${page} page(s)`);
	return artists;
};

interface UserWithToken extends User {
	accessToken: string;
}

const loadUsersWithTokens = async (env: Env): Promise<UserWithToken[]> => {
	const users = await listUsers(env.POSTED_ALBUMS);
	if (users.length === 0) {
		console.log('No linked users found');
		return [];
	}

	const loaded = await Promise.all(
		users.map(async (user) => {
			try {
				const accessToken = await refreshSpotifyAccessToken(env, user.refreshToken);
				return { ...user, accessToken };
			} catch (error) {
				console.error(`Failed to refresh token for spotify user ${user.spotifyUserId}:`, error);
				return null;
			}
		}),
	);

	return loaded.filter((user): user is UserWithToken => user !== null);
};

interface ArtistSubscribers {
	artist: SpotifyApi.ArtistObjectFull;
	discordUserIds: string[];
	accessToken: string;
}

type NotificationPhase = 'presave' | 'release';

interface NotifiedState {
	notifiedIds: Set<string>;
	// True when this artist has never been recorded before (no KV entry yet).
	isFirstSight: boolean;
}

const getNotifiedAlbums = async (kv: KVNamespace, artistId: string): Promise<NotifiedState> => {
	const stored = await kv.get<string[]>(artistKey(artistId), 'json');
	return { notifiedIds: new Set(stored ?? []), isFirstSight: stored === null };
};

const saveNotifiedAlbums = async (kv: KVNamespace, artistId: string, ids: Set<string>): Promise<void> => {
	await kv.put(artistKey(artistId), JSON.stringify([...ids]));
};

const hasNotified = (notifiedIds: Set<string>, albumId: string, phase: NotificationPhase): boolean =>
	notifiedIds.has(`${albumId}:${phase}`);

const markNotified = (notifiedIds: Set<string>, albumId: string, phase: NotificationPhase): void => {
	notifiedIds.add(`${albumId}:${phase}`);
};

const formatArtistNames = (artists: SpotifyApi.ArtistObjectSimplified[]): string =>
	artists.map((artist) => `[${artist.name}](${artist.external_urls.spotify})`).join(', ');

const formatReleaseType = (album: SpotifyApi.AlbumObjectSimplified): string => {
	if (album.album_type === 'single') return 'Single';
	if (album.album_type === 'compilation') return 'Compilation';
	if (album.total_tracks <= 6) return 'EP';
	return 'Album';
};

const formatReleaseDate = (album: SpotifyApi.AlbumObjectSimplified): string => {
	if (album.release_date_precision === 'month') {
		const [year, month] = album.release_date.split('-');
		const monthName = new Date(Number(year), Number(month) - 1).toLocaleString('en-US', { month: 'long' });
		return `${monthName} ${year}`;
	}

	return album.release_date;
};

// Spotify release dates are calendar dates; compare against local midnight, not UTC.
const RELEASE_TIMEZONE = 'Australia/Sydney';

const getLocalYmd = (date: Date): { year: number; month: number; day: number } => {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: RELEASE_TIMEZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(date);

	const part = (type: Intl.DateTimeFormatPartTypes): number =>
		Number(parts.find((p) => p.type === type)?.value);

	return { year: part('year'), month: part('month'), day: part('day') };
};

const ymdToOrdinal = (year: number, month: number, day: number): number => year * 10_000 + month * 100 + day;

const getReleaseYmd = (album: SpotifyApi.AlbumObjectSimplified): { year: number; month: number; day: number } => {
	const [year, month = '1', day = '1'] = album.release_date.split('-');
	const y = Number(year);
	const m = Number(month);

	if (album.release_date_precision === 'day') {
		return { year: y, month: m, day: Number(day) };
	}
	if (album.release_date_precision === 'month') {
		return { year: y, month: m, day: 1 };
	}
	return { year: y, month: 1, day: 1 };
};

const isAlbumReleased = (album: SpotifyApi.AlbumObjectSimplified, now = new Date()): boolean => {
	const local = getLocalYmd(now);
	const release = getReleaseYmd(album);
	return ymdToOrdinal(release.year, release.month, release.day) <= ymdToOrdinal(local.year, local.month, local.day);
};

const isAlbumPresave = (album: SpotifyApi.AlbumObjectSimplified, now = new Date()): boolean =>
	!isAlbumReleased(album, now);

// Released strictly before today (local time) — i.e. back catalog, not a same-day drop.
const isAlbumBackCatalog = (album: SpotifyApi.AlbumObjectSimplified, now = new Date()): boolean => {
	const local = getLocalYmd(now);
	const release = getReleaseYmd(album);
	return ymdToOrdinal(release.year, release.month, release.day) < ymdToOrdinal(local.year, local.month, local.day);
};

const MAX_TRACKLIST_TRACKS = 30;

const durationFormatter = new Intl.DurationFormat('en', { style: 'narrow' });

const formatDuration = (durationMs: number): string => {
	const totalSeconds = Math.floor(durationMs / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;

	const duration: Partial<Record<Intl.DurationFormatUnit, number>> = { seconds };
	if (hours > 0) duration.hours = hours;
	if (minutes > 0) duration.minutes = minutes;

	return durationFormatter.format(duration);
};

const formatTrackList = (tracks: SpotifyApi.TrackObjectSimplified[], totalAlbumTracks: number): string => {
	const shown = tracks.slice(0, MAX_TRACKLIST_TRACKS);
	const lines = shown.map((track, index) => {
		const position = `${index + 1}.`;
		const link = `[${track.name}](${track.external_urls.spotify})`;
		const duration = `(\`${formatDuration(track.duration_ms)}\`)`;
		if (track.is_playable === false) {
			return `~~${position} ${link}~~ (unavailable) ${duration}`;
		}
		return `${position} ${link} ${duration}`;
	});

	const truncated = tracks.length - shown.length;
	if (truncated > 0) {
		lines.push(`…and ${truncated} more`);
	}

	const notYetListed = totalAlbumTracks - tracks.length;
	if (notYetListed > 0) {
		lines.push(`…and ${notYetListed} more not yet listed`);
	}

	return lines.join('\n');
};

const getAlbumTracks = async (
	accessToken: string,
	album: SpotifyApi.AlbumObjectSimplified,
): Promise<SpotifyApi.TrackObjectSimplified[]> => {
	const tracks: SpotifyApi.TrackObjectSimplified[] = [];
	let url: string | null =
		`https://api.spotify.com/v1/albums/${album.id}/tracks?market=US&limit=50`;

	while (url !== null) {
		const data: SpotifyApi.AlbumTracksResponse = await spotifyFetchJson(
			url,
			{ headers: { Authorization: `Bearer ${accessToken}` } },
			`Failed to fetch tracks for album ${album.name} (${album.id})`,
		);

		tracks.push(...data.items);
		url = data.next;
	}

	return tracks;
};

const buildAlbumEmbed = (
	album: SpotifyApi.AlbumObjectSimplified,
	followedArtist: SpotifyApi.ArtistObjectFull,
	discordUserIds: string[],
	tracks: SpotifyApi.TrackObjectSimplified[],
	phase: NotificationPhase,
) => ({
	content: discordUserIds.map((id) => `<@${id}>`).join(' '),
	embeds: [
		{
			title: album.name,
			url: album.external_urls.spotify,
			color: DISCORD_EMBED_COLOR,
			timestamp: new Date().toISOString(),
			author: {
				name: followedArtist.name,
				url: followedArtist.external_urls.spotify,
				...(followedArtist.images.length > 0 && { icon_url: followedArtist.images[0].url }),
			},
			...(album.images.length > 0 && { thumbnail: { url: album.images[0].url } }),
			fields: [
				{ name: album.artists.length > 1 ? 'Artists' : 'Artist', value: formatArtistNames(album.artists), inline: false },
				{ name: 'Type', value: formatReleaseType(album), inline: true },
				{ name: 'Tracks', value: String(album.total_tracks), inline: true },
				{ name: 'Release Date', value: formatReleaseDate(album), inline: true },
				{ name: 'Status', value: phase === 'presave' ? 'Pre-save' : 'Released', inline: true },
				...(tracks.length > 0
					? [{ name: 'Tracklist', value: formatTrackList(tracks, album.total_tracks), inline: false }]
					: []),
			],
			footer: { text: 'Spotify', icon_url: SPOTIFY_FOOTER_ICON },
		},
	],
});

const postToDiscord = pThrottle({
	limit: DISCORD_MAX_REQUESTS,
	interval: DISCORD_RATE_WINDOW_MS,
	onDelay: () => {
		console.log(`Discord rate limit reached (${DISCORD_MAX_REQUESTS}/${DISCORD_RATE_WINDOW_MS}ms), queuing webhook`);
	},
})(async (webhookUrl: string, payload: unknown): Promise<void> => {
	await discordFetchOk(
		webhookUrl,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		},
		'Discord webhook',
	);
});

interface RunOptions {
	seed?: boolean;
}

const processArtist = async (
	artist: SpotifyApi.ArtistObjectFull,
	accessToken: string,
	webhookUrl: string,
	kv: KVNamespace,
	seed: boolean,
	discordUserIds: string[],
): Promise<number> => {
	try {
		const { notifiedIds: notifiedAlbums, isFirstSight } = await getNotifiedAlbums(kv, artist.id);

		const { items } = await spotifyFetchJson<SpotifyApi.ArtistsAlbumsResponse>(
			`https://api.spotify.com/v1/artists/${artist.id}/albums?include_groups=album,single&market=US&limit=${ALBUMS_PER_ARTIST}`,
			{ headers: { Authorization: `Bearer ${accessToken}` } },
			`Failed to fetch albums for artist ${artist.name} (${artist.id})`,
		);

		const now = new Date();
		let recorded = 0;

		for (const album of items) {
			const phases: NotificationPhase[] = [];

			if (isAlbumPresave(album, now) && !hasNotified(notifiedAlbums, album.id, 'presave')) {
				phases.push('presave');
			}
			if (isAlbumReleased(album, now) && !hasNotified(notifiedAlbums, album.id, 'release')) {
				phases.push('release');
			}

			if (phases.length === 0) continue;

			// On first sight of an artist, silently record their back catalogue (anything
			// released before today) so newly followed artists don't spam old releases.
			// Same-day drops and presaves still post.
			const suppressPost = seed || (isFirstSight && isAlbumBackCatalog(album, now));

			const releaseSummary = `${formatReleaseType(album)} "${album.name}" by ${formatArtistNames(album.artists)} (${album.total_tracks} tracks, ${album.release_date})`;

			// Fetch tracks once per album across all phases (skipped when not posting).
			const tracks = suppressPost ? [] : await getAlbumTracks(accessToken, album);

			for (const phase of phases) {
				markNotified(notifiedAlbums, album.id, phase);
				recorded++;

				if (suppressPost) {
					console.log(`Seeding (${phase}): ${releaseSummary}`);
				} else {
					console.log(`Notifying (${phase}): ${releaseSummary} → ${discordUserIds.join(', ')}`);
					await postToDiscord(webhookUrl, buildAlbumEmbed(album, artist, discordUserIds, tracks, phase));
				}
			}
		}

		await saveNotifiedAlbums(kv, artist.id, notifiedAlbums);

		if (recorded > 0) {
			console.log(
				seed
					? `${artist.name}: recorded ${recorded} notification(s) without posting`
					: `${artist.name}: sent ${recorded} notification(s)`,
			);
		}

		return recorded;
	} catch (error) {
		console.error(`Failed to process ${artist.name} (${artist.id}):`, error);
		return 0;
	}
};

const buildArtistMap = async (users: UserWithToken[]): Promise<Map<string, ArtistSubscribers>> => {
	const byArtistId = new Map<string, ArtistSubscribers>();

	for (const user of users) {
		const artists = await getFollowedArtists(user.accessToken);
		for (const artist of artists) {
			const existing = byArtistId.get(artist.id);
			if (existing) {
				if (!existing.discordUserIds.includes(user.discordUserId)) {
					existing.discordUserIds.push(user.discordUserId);
				}
			} else {
				byArtistId.set(artist.id, {
					artist,
					discordUserIds: [user.discordUserId],
					accessToken: user.accessToken,
				});
			}
		}
	}

	return byArtistId;
};

export const runCheck = async (env: Env, trigger: string, options: RunOptions = {}): Promise<void> => {
	const { seed = false } = options;
	const startedAt = Date.now();
	console.log(`Starting spotify check (trigger: ${trigger}${seed ? ', seed mode' : ''})`);

	const users = await loadUsersWithTokens(env);
	if (users.length === 0) {
		return;
	}

	const artistMap = await buildArtistMap(users);
	const limit = pLimit(SPOTIFY_CONCURRENCY);

	console.log(
		`Processing ${artistMap.size} unique artist(s) for ${users.length} user(s) (concurrency: ${SPOTIFY_CONCURRENCY})`,
	);

	const recordedPerArtist = await Promise.all(
		[...artistMap.values()].map(({ artist, discordUserIds, accessToken }) =>
			limit(() =>
				processArtist(artist, accessToken, env.DISCORD_WEBHOOK_URL, env.POSTED_ALBUMS, seed, discordUserIds),
			),
		),
	);

	const totalRecorded = recordedPerArtist.reduce((sum, count) => sum + count, 0);
	const artistsWithNewAlbums = recordedPerArtist.filter((count) => count > 0).length;
	const elapsedMs = Date.now() - startedAt;

	console.log(
		seed
			? `Seed complete in ${elapsedMs}ms: ${totalRecorded} album(s) recorded for ${artistsWithNewAlbums} artist(s)`
			: `Check complete in ${elapsedMs}ms: ${totalRecorded} notification(s) for ${artistsWithNewAlbums} artist(s)`,
	);
};
