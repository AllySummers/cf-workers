interface Env {
	SPOTIFY_CLIENT_ID: string;
	SPOTIFY_CLIENT_SECRET: string;
	SPOTIFY_REFRESH_TOKEN: string;
	DISCORD_WEBHOOK_URL: string;
}

interface SpotifyTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
}

interface SpotifyAlbum {
	id: string;
	name: string;
	release_date: string;
	external_urls: { spotify: string };
	images: Array<{ url: string; height: number; width: number }>;
}

interface SpotifyAlbumsResponse {
	items: SpotifyAlbum[];
}

// Add Spotify artist IDs to track here.
const ARTIST_IDS: string[] = [
	// e.g. '3TVXtAsR1Inumwj472S9r4'
];

// Number of recent albums to fetch per artist.
const ALBUMS_PER_ARTIST = 5;

async function getSpotifyAccessToken(env: Env): Promise<string> {
	const credentials = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);

	const response = await fetch('https://accounts.spotify.com/api/token', {
		method: 'POST',
		headers: {
			Authorization: `Basic ${credentials}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: env.SPOTIFY_REFRESH_TOKEN,
		}),
	});

	if (!response.ok) {
		throw new Error(`Spotify token refresh failed: ${response.status} ${response.statusText}`);
	}

	const data = (await response.json()) as SpotifyTokenResponse;
	return data.access_token;
}

async function postToDiscord(webhookUrl: string, payload: unknown): Promise<void> {
	const response = await fetch(webhookUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		throw new Error(`Discord webhook failed: ${response.status} ${response.statusText}`);
	}
}

async function processArtist(artistId: string, accessToken: string, webhookUrl: string): Promise<void> {
	const response = await fetch(
		`https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single&market=US&limit=${ALBUMS_PER_ARTIST}`,
		{ headers: { Authorization: `Bearer ${accessToken}` } },
	);

	if (!response.ok) {
		console.error(`Failed to fetch albums for artist ${artistId}: ${response.status}`);
		return;
	}

	const { items } = (await response.json()) as SpotifyAlbumsResponse;

	await Promise.all(
		items.map((album) =>
			postToDiscord(webhookUrl, {
				embeds: [
					{
						title: album.name,
						url: album.external_urls.spotify,
						color: 0x1db954,
						...(album.images.length > 0 && { thumbnail: { url: album.images[0].url } }),
						fields: [{ name: 'Release Date', value: album.release_date, inline: true }],
					},
				],
			}),
		),
	);
}

export default {
	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		const accessToken = await getSpotifyAccessToken(env);
		await Promise.all(ARTIST_IDS.map((id) => processArtist(id, accessToken, env.DISCORD_WEBHOOK_URL)));
	},
} satisfies ExportedHandler<Env>;
