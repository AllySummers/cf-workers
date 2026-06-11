import { runCheck } from './check';
import type { AppHandler } from './auth';

export const runRoute: AppHandler = async (c) => {
	if (c.req.header('Authorization') !== `Bearer ${c.env.TRIGGER_SECRET}`) {
		return c.text('Unauthorized', 401);
	}

	const seed = c.req.query('seed') !== undefined;
	await runCheck(c.env, seed ? 'manual (seed)' : 'manual', { seed });
	return c.text(seed ? 'ok (seeded)' : 'ok');
};
