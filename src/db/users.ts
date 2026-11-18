import { db } from './index.ts';
import { users } from './schema.ts';

export async function getOrCreateUser(uid: string, email: string) {
  try {
    const result = await db
      .insert(users)
      .values({
        uid,
        email: email || `${uid}@firebase.local`,
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email: email || `${uid}@firebase.local`,
        },
      })
      .returning();

    return result[0];
  } catch (error) {
    console.error('Failed to upsert user:', error);
    throw new Error('Failed to synchronize user account.', { cause: error });
  }
}
