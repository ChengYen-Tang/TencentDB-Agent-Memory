/**
 * 内置 provider 注册入口。
 *
 * 新接入平台的**唯一改动点**：
 *   1. 在同目录建 `<id>.ts`，导出 `<id>Provider: ICodeSourceProvider`
 *   2. 在下面 BUILTIN_PROVIDERS 数组加一行
 *
 * 是否启用某平台由部署环境 `CODE_SOURCE_ENABLED` 决定，与本表解耦。
 *
 * SSH 与 Azure DevOps 默认启用；其余来源按 CODE_SOURCE_ENABLED 过滤。
 */

import type { ICodeSourceProvider } from "../types.js";
import { gongfengProvider } from "./gongfeng.js";
import { sshProvider, SSH_PROVIDER_ID } from "./ssh.js";
import { azureDevOpsProvider } from "./azure-devops.js";

/** 全部内置 provider（是否启用由 CODE_SOURCE_ENABLED 过滤，不代表全部会展示给用户）。 */
export const BUILTIN_PROVIDERS: readonly ICodeSourceProvider[] = [
  gongfengProvider,
];

/** 默认启用的来源（不受部署配置过滤）。 */
export const ALWAYS_ON_PROVIDERS: readonly ICodeSourceProvider[] = [
  sshProvider,
  azureDevOpsProvider,
];

export { sshProvider, SSH_PROVIDER_ID };
