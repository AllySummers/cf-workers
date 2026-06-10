/// <reference types="spotify-api" />

// OAuth token endpoint is not covered by @types/spotify-api.
interface SpotifyTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
}

// Number of recent albums to fetch per artist.
const ALBUMS_PER_ARTIST = 5;

const fetchOk = async (url: string | URL, init?: RequestInit, context?: string): Promise<Response> => {
	const response = await fetch(url, init);

	if (!response.ok) {
		throw new Error(`${context ?? 'Request'} failed: ${response.status} ${response.statusText}`);
	}

	return response;
}

const fetchJson = async <T>(url: string | URL, init?: RequestInit, context?: string): Promise<T> => {
	return (await fetchOk(url, init, context)).json() as Promise<T>;
};

const getSpotifyAccessToken = async (env: Env): Promise<string> => {
	const credentials = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);

	const data = await fetchJson<SpotifyTokenResponse>(
		'https://accounts.spotify.com/api/token',
		{
			method: 'POST',
			headers: {
				Authorization: `Basic ${credentials}`,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: env.SPOTIFY_REFRESH_TOKEN,
			}),
		},
		'Spotify token refresh',
	);

	return data.access_token;
}

const getFollowedArtists = async (accessToken: string): Promise<SpotifyApi.ArtistObjectFull[]> => {
	const artists: SpotifyApi.ArtistObjectFull[] = [];
	let url: string | null = 'https://api.spotify.com/v1/me/following?type=artist&limit=50';

	while (url !== null) {
		const data: SpotifyApi.UsersFollowedArtistsResponse = await fetchJson(
			url,
			{ headers: { Authorization: `Bearer ${accessToken}` } },
			'Failed to fetch followed artists',
		);

		artists.push(...data.artists.items);
		url = data.artists.next;
	}

	return artists;
}

const postToDiscord = async (webhookUrl: string, payload: unknown): Promise<void> => {
	await fetchOk(
		webhookUrl,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		},
		'Discord webhook',
	);
}

const processArtist = async (artistId: string, accessToken: string, webhookUrl: string): Promise<void> => {
	try {
		const { items } = await fetchJson<SpotifyApi.ArtistsAlbumsResponse>(
			`https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single&market=US&limit=${ALBUMS_PER_ARTIST}`,
			{ headers: { Authorization: `Bearer ${accessToken}` } },
			`Failed to fetch albums for artist ${artistId}`,
		);

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
	} catch (error) {
		console.error(error);
	}
}

export default {
	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		const accessToken = await getSpotifyAccessToken(env);
		const artists = await getFollowedArtists(accessToken);
		await Promise.all(artists.map((artist) => processArtist(artist.id, accessToken, env.DISCORD_WEBHOOK_URL)));
	},
} satisfies ExportedHandler<Env>;
