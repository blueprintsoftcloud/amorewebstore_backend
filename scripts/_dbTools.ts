// scripts/_dbTools.ts
// Shared connection-string helpers for backup.ts / restore.ts / restoreDrill.ts.

export const dbNameFromUri = (uri: string): string => {
  const match = uri.match(/\/([^/?]+)(\?|$)/);
  return match ? match[1] : "(unknown)";
};

/** Swaps the database name segment of a Mongo connection string for a different one. */
export const withDbName = (uri: string, newDbName: string): string =>
  uri.replace(/\/([^/?]+)(\?|$)/, `/${newDbName}$2`);
