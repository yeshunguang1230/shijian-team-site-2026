// Compatibility entry point; the account-aware suite includes D1 persistence.
await import('./collaboration-migration.mjs');
await import('./auth-e2e.mjs');
