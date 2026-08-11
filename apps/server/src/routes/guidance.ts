import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { isRepoUrl, repoCachePath } from "@anvil/core";
import { serverAnvilRoot } from "../services/review.js";

/** 预览内容最多返回 2000 字符，超出截断（完整内容以仓库内 ANVIL.md 为准）。 */
const MAX_GUIDANCE_PREVIEW = 2000;

export function registerGuidanceRoutes(app: FastifyInstance) {
  // 仓库常驻指引（ANVIL.md）预览：web 创建任务时展示"将随任务注入"的内容
  // 前提：单机版绑定 127.0.0.1、无需鉴权（与 GET /api/issues 同级）；若未来暴露到局域网，此端点会变成本地路径探测面，需重新评估
  app.get("/api/guidance", async (req, reply) => {
    const { repo } = req.query as { repo?: string };
    if (!repo) return reply.code(400).send({ error: "repo required" });
    const repoDir = isRepoUrl(repo) ? repoCachePath(repo, serverAnvilRoot()) : repo;
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoDir, "ANVIL.md"), "utf8");
    } catch {
      // 文件不存在（含 URL 缓存未克隆）或读取失败，一律按未命中处理
      return { found: false };
    }
    // 纯空白文件与 runner 侧对齐（runner 对空白指引不注入）：按未命中处理，避免预览"说谎"
    if (!content.trim()) return { found: false };
    const truncated = content.length > MAX_GUIDANCE_PREVIEW;
    return { found: true, content: content.slice(0, MAX_GUIDANCE_PREVIEW), truncated };
  });
}
