import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // 默认 forks 进程池在部分 Windows 环境加载测试即崩（实测 Node 22/24 均复现），
    // vmForks 功能等价且稳定，固定下来保证 `npm test` 在任何机器可复现。
    pool: "vmForks",
  },
});
