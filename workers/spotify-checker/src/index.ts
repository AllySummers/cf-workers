import { Hono } from 'hono';

import { authDiscordCallbackRoute, authSpotifyCallbackRoute, linkRoute } from './auth';
import { runCheck } from './check';
import { runRoute } from './run';

const app = new Hono<{ Bindings: Env }>();

app
	.get('/link', linkRoute)
	.get('/auth/spotify/callback', authSpotifyCallbackRoute)
	.get('/auth/discord/callback', authDiscordCallbackRoute)
	.post('/run', runRoute);

export default {
	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		await runCheck(env, 'cron');
	},

	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
