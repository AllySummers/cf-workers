// Augments the Cloudflare Workers Env bindings with this worker's secrets.
interface Env {
	SPOTIFY_CLIENT_ID: string;
	SPOTIFY_CLIENT_SECRET: string;
	SPOTIFY_REFRESH_TOKEN: string;
	DISCORD_WEBHOOK_URL: string;
}
