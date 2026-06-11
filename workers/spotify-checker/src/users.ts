export interface User {
	spotifyUserId: string;
	refreshToken: string;
	discordUserId: string;
}

const spotifyTokenKey = (spotifyUserId: string): string => `spotify-token:${spotifyUserId}`;
const discordUserKey = (spotifyUserId: string): string => `discord-user:${spotifyUserId}`;

export const saveUser = async (kv: KVNamespace, user: User): Promise<void> => {
	await Promise.all([
		kv.put(spotifyTokenKey(user.spotifyUserId), user.refreshToken),
		kv.put(discordUserKey(user.spotifyUserId), user.discordUserId),
	]);
};

export const listUsers = async (kv: KVNamespace): Promise<User[]> => {
	const { keys } = await kv.list({ prefix: 'spotify-token:' });
	const users = await Promise.all(
		keys.map(async ({ name }) => {
			const spotifyUserId = name.slice('spotify-token:'.length);
			const [refreshToken, discordUserId] = await Promise.all([
				kv.get(name),
				kv.get(discordUserKey(spotifyUserId)),
			]);
			if (!refreshToken || !discordUserId) {
				return null;
			}
			return { spotifyUserId, refreshToken, discordUserId };
		}),
	);
	return users.filter((user): user is User => user !== null);
};
