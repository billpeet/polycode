/**
 * Convert a Windows absolute path to its WSL /mnt/... equivalent.
 * e.g. C:\Users\foo\bar  →  /mnt/c/Users/foo/bar
 */
export function windowsPathToWsl(winPath: string): string {
  return winPath
    .replace(/^([A-Za-z]):[/\\]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`)
    .replace(/\\/g, '/')
}
