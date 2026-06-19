// @atcute/oauth-node-client SessionStore backed by the AppView's
// AccountStore. Mirrors the console's SqliteOauthSessionStore (same
// JSON blob format in the `oauth_sessions` table) so a session minted by
// the console's login handshake and handed off to the AppView restores
// here byte-for-byte.
//
// The interface is synchronous by contract (the OAuth client calls
// `get()` inline during `restore()`), which is why the backing store is
// local SQLite, not a remote service. Each `OAuthSession.handle()` token
// refresh writes back through `set()`, so this is also the persistence
// hook for token rotation — and the reason exactly one process may own a
// given session's refresh at a time.
//
// Note: StoredSession contains the DPoP private key. Treat the account
// DB file as a credentials store; mount it on a non-public volume.

import type { Did } from "@atcute/lexicons";
import type { Store, StoredSession } from "@atcute/oauth-node-client";

import type { AccountStore } from "../operational/account-store.ts";

export class AccountOauthSessionStore implements Store<Did, StoredSession> {
  constructor(private readonly accounts: AccountStore) {}

  get(key: Did): StoredSession | undefined {
    const data = this.accounts.getOAuthSession(key);
    if (!data) return undefined;
    try {
      return JSON.parse(data) as StoredSession;
    } catch {
      return undefined;
    }
  }

  set(key: Did, value: StoredSession): void {
    this.accounts.putOAuthSession(key, JSON.stringify(value));
  }

  delete(key: Did): void {
    this.accounts.deleteOAuthSession(key);
  }

  clear(): void {
    this.accounts.clearOAuthSessions();
  }
}
