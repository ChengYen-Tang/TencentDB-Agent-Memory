import type { ICodeSourceProvider } from "../types.js";
import { bearerAuthMethod } from "../auth-methods/bearer.js";
import type { GitFetchOptions } from "../../source-fetcher/types.js";

/** Azure Repos Git accepts a PAT as the password of HTTP Basic auth. */
export const AZURE_DEVOPS_PROVIDER_ID = "azure-devops";
export const azureDevOpsProvider: ICodeSourceProvider = {
  id: AZURE_DEVOPS_PROVIDER_ID,
  authMethod: bearerAuthMethod,
  cloneUsername: "pat",
  sitePaths: {},
};

export function azureDevOpsHttpOptions(secret: string): NonNullable<GitFetchOptions["http"]> {
  return {
    authorization: `Authorization: Basic ${Buffer.from(`pat:${secret}`, "utf8").toString("base64")}`,
    verifyTls: process.env.CODE_SOURCE_AZURE_DEVOPS_VERIFY_TLS?.trim().toLowerCase() === "true",
  };
}
