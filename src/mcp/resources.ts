/**
 * MCP Server - 原生 Resources 与 Prompts 注册
 * 让不支持外部 Skill 机制的通用 MCP 客户端（如 Claude Desktop、Cherry Studio 等）
 * 也能直接读取米家极客版自动化指南、紧凑文本语法和标准工作流提示词。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * 定位项目或已安装 npm 包的根目录
 * - 编译产物在 dist/mcp/mcp/ -> 上溯三级为包根目录
 * - tsx 源码运行在 src/mcp/ -> 上溯两级为仓库根目录
 */
function resolvePackageRoot(): string {
  for (const relative of ["../../..", "../.."]) {
    const candidate = join(__dirname, relative);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }
  return process.cwd();
}

function readBundledDoc(relativePath: string, fallbackTitle: string): string {
  const root = resolvePackageRoot();
  const fullPath = join(root, relativePath);
  try {
    if (existsSync(fullPath)) {
      return readFileSync(fullPath, "utf8");
    }
  } catch {
    // 忽略读取异常，回退简要提示
  }
  return `# ${fallbackTitle}\n\n未在当前运行目录找到本地文档 (${relativePath})，请参考仓库文档或加载 mijia-automation Skill。`;
}

export function registerMcpResourcesAndPrompts(server: McpServer): void {
  // ==================== Resources ====================

  server.registerResource(
    "mijia-automation-skill",
    "mijia://guides/automation-skill",
    {
      title: "米家自动化极客版规则创建指南 (SKILL)",
      description: "包含设计模式索引、变量生命周期、连接完整性规则、常用节点模板与标准工作流",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: readBundledDoc(".agents/skills/mijia-automation/SKILL.md", "米家自动化规则指南"),
        },
      ],
    })
  );

  server.registerResource(
    "mijia-rule-text-format",
    "mijia://guides/rule-text-format",
    {
      title: "米家规则紧凑文本格式规范 (Rule Text DSL)",
      description: "一行一个节点的紧凑规则文本语法，适用于 mijia_get_graph(format=text)、mijia_create_graph(text) 与 mijia_patch_graph",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: readBundledDoc("docs/rule-text-format.md", "规则紧凑文本格式规范"),
        },
      ],
    })
  );

  server.registerResource(
    "mijia-complete-reference",
    "mijia://guides/complete-reference",
    {
      title: "米家极客版全量节点字段与校验参考",
      description: "全部节点类型的详细 props/cfg/inputs/outputs 定义与边界注意事项",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: readBundledDoc(
            ".agents/skills/mijia-automation/references/mijia-complete-reference.md",
            "米家全量节点定义参考"
          ),
        },
      ],
    })
  );

  server.registerResource(
    "mijia-patterns-index",
    "mijia://guides/patterns-index",
    {
      title: "米家自动化可复用模式索引",
      description: "状态保持、数值映射、多源聚合、时间节律、循环恢复与双向同步等模式索引",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: readBundledDoc(
            ".agents/skills/mijia-automation/references/index.md",
            "米家自动化模式索引"
          ),
        },
      ],
    })
  );

  // ==================== Prompts ====================

  server.registerPrompt(
    "create-automation",
    {
      title: "创建米家自动化规则",
      description: "按标准安全流程查询设备 MIOT Spec、设计状态与边界、通过双校验并创建米家极客版自动化规则",
      argsSchema: {
        requirement: z.string().describe("自然语言描述的自动化需求，例如：卫生间有人移动且光照低于 30 lux 时开镜前灯，无人 5 分钟关灯"),
      },
    },
    async ({ requirement }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `请帮我创建以下米家极客版自动化规则：
「${requirement}」

请严格按以下步骤执行：
1. 先读取资源 \`mijia://guides/automation-skill\` 和 \`mijia://guides/rule-text-format\`（若已加载 \`mijia-automation\` Skill 可直接复用）。
2. 调用 \`mijia_status\` 确认网关已连接，再用 \`mijia_get_devices\` 找到目标设备 DID，批量调用 \`mijia_get_device\` 获取真实 MIOT Spec（原样记录 \`urn\`、\`siid/piid\`、权限与取值范围）。
3. 列出简明设计方案（触发事件、持续条件、动作、异常恢复与拟定规则名称）供我确认。
4. 在我确认后，优先使用紧凑文本 \`mijia_create_graph({ name, text })\`（复杂超过 10 节点可用 \`mijia_graph_draft_*\`）完成创建并回读验证。`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "diagnose-rule",
    {
      title: "诊断自动化规则为何未按预期执行",
      description: "结合规则拓扑结构、MIOT 能力校验与网关执行日志排查自动化失效原因",
      argsSchema: {
        rule: z.string().describe("要排查的规则名称或规则 ID"),
        symptom: z.string().optional().describe("可选：观察到的异常现象，例如：人离开后灯一直不关"),
      },
    },
    async ({ rule, symptom }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `请帮我排查米家自动化规则「${rule}」${symptom ? `（现象：${symptom}）` : ""}：
1. 若未知规则 ID，先调 \`mijia_get_graphs\` 定位 ID。
2. 并行调用：
   - \`mijia_get_graph({ id, format: "text" })\` 查看完整逻辑与连线
   - \`mijia_get_log({ graph: id, summary: true, minutes: 180 })\` 查看各节点触发计数，定位断链位置
   - \`mijia_validate_graph({ id })\` 与 \`mijia_validate_graph_capabilities({ id })\` 检查结构与设备属性权限
3. 结合常见陷阱（如 \`deviceInput\` 双边沿信号、\`statusLast\` 需状态翻转才能二次触发、\`condition\` 缺少 \`condition\` 端口等）给出根因分析与 \`mijia_patch_graph\` 修复建议。`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "modify-rule",
    {
      title: "增量修改现有自动化规则",
      description: "使用紧凑文本一读一写安全修改已有规则，保留原有卡片排版并记录变更备注",
      argsSchema: {
        rule: z.string().describe("目标规则名称或规则 ID"),
        change: z.string().describe("希望修改的内容"),
      },
    },
    async ({ rule, change }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `请帮我修改米家自动化规则「${rule}」：${change}

执行要求：
1. 用 \`mijia_get_graph({ id, format: "text" })\` 读取当前紧凑文本与 \`hash\`。
2. 先用 \`mijia_patch_graph({ id, baseHash, ..., dryRun: true })\` 预览差异和布局检查结果并向我展示。
3. 获我确认后，去掉 \`dryRun\` 写入网关（严禁用 \`mijia_update_graph\` 整图 JSON 覆盖）。`,
          },
        },
      ],
    })
  );
}
