/** Azure Repos HTTPS clone URLs generally end in /_git/<repo>, without .git. */
export function isAzureDevOpsHttpsUrl(raw: string): boolean {
  return /^https:\/\/[^\s/?#@]+\/(?:[^\s/?#]+\/)*_git\/[^\s/?#]+\/?$/i.test(raw.trim());
}
